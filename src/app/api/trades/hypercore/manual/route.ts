import { NextResponse } from "next/server";
import { z } from "zod";
import { executeHypercoreManualTrade } from "@/lib/engine/hypercore-paper-trading";
import { apiError } from "@/lib/utils/api";
import { store } from "@/lib/repositories/store";
import { assertSameOrigin } from "@/lib/security/same-origin";
import { hypercoreExecutionAdapter } from "@/lib/execution/hypercore-execution-adapter";
import { publishEvent } from "@/lib/services/audit-service";
import { reconcileAfterLiveExecution } from "@/lib/services/live-certification";
import { assertLiveDailyLossLimit } from "@/lib/services/live-equity";
import { applyShadowBuy, applyShadowSell, assertShadowPortfolioRisk, consumedCost } from "@/lib/services/execution-accounting";
import { hypercoreRequiredCapitalUsd } from "@/lib/execution/hypercore-execution-math";
import { assertNetworkFeeLimit } from "@/lib/execution/network-fee-guard";
import { assertNetworkExecutionLimit, getNetworkExecutionLimit } from "@/lib/execution/network-execution-risk";
import { assertPriceDeviation, prepareFreshQuote } from "@/lib/execution/execution-quote-guard";
import { publishEmergencyExitDeviation } from "@/lib/services/emergency-exit-notification";
import { assertAssetExecutionPolicy } from "@/lib/engine/asset-execution-policy";
import { claimExecutionAttempt, createManualExecutionKey, recordExecutionFailure, runLiveSubmission } from "@/lib/services/execution-lifecycle";

const schema = z.object({
  coin: z.string().min(1).max(40),
  positionId: z.string().min(1).max(200).optional(),
  marketType: z.enum(["spot", "perp"]),
  positionSide: z.enum(["long", "short"]),
  action: z.enum(["open", "close"]),
  allocationPercent: z.number().min(1).max(25).optional(),
  closePercent: z.number().min(1).max(100).optional(),
  leverage: z.number().min(1).max(50).optional(),
  requestId: z.string().uuid().optional(),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = schema.parse(await request.json());
    const mode = store.getMode();
    if (mode !== "paper") {
      const requestId = input.requestId ?? crypto.randomUUID();
      const assetKey = `${input.marketType}:${input.coin}`.toLowerCase();
      const idempotencyKey = createManualExecutionKey({ mode, chainId: "hyperliquid", action: input.action, asset: assetKey, allocationPercent: input.allocationPercent, closePercent: input.closePercent, leverage: input.leverage, positionSide: input.positionSide });
      const claim = claimExecutionAttempt({ requestId, idempotencyKey, integrationId: "hyperliquid", mode, source: "manual", action: input.action, asset: input.coin });
      if (!claim.created) return NextResponse.json({ execution: claim.attempt, duplicate: true });
      try {
        const openLots = store.getOpenExecutionLots({ integrationId: "hyperliquid", mode, assetKey, positionSide: input.positionSide });
        const trackedQuantity = openLots.reduce((sum, lot) => sum + Number(lot.amount), 0);
        const exactCloseQuantity = input.action === "close" ? trackedQuantity * (input.closePercent ?? 100) / 100 : undefined;
        if (input.action === "close" && (!exactCloseQuantity || exactCloseQuantity <= 0)) throw new Error("Seçilen piyasa için açık shadow/live lotu bulunamadı.");
        const settings = store.getRiskSettings();
        const intent = { ...input, exactCloseQuantity, slippagePercent: 0.5, mode } as const;
        const prepared = await prepareFreshQuote({ chainId: "hyperliquid", settings, prepare: () => hypercoreExecutionAdapter.prepare(intent), quotedAt: (current) => current.quotedAt });
        const plan = prepared.plan;
        const assetPolicy = assertAssetExecutionPolicy({ chainId: "hyperliquid", asset: assetKey, opensPosition: input.action === "open", settings, marketType: plan.marketType, volume24hUsd: plan.volume24hUsd, openInterestUsd: plan.openInterestUsd });
        const quoteGuard = assertPriceDeviation({ chainId: "hyperliquid", side: input.action === "open" ? "buy" : "sell", referencePriceUsd: plan.referencePriceUsd, quotedPriceUsd: Number(plan.limitPrice), quotedAt: plan.quotedAt, quoteRefreshed: prepared.quoteRefreshed, emergencyExit: input.action === "close" && (input.closePercent ?? 100) === 100, settings });
        const networkLimit = getNetworkExecutionLimit("hyperliquid", settings);
        assertNetworkExecutionLimit({ chainId: "hyperliquid", tradeUsd: plan.notionalUsd, minimumTradableNotionalUsd: plan.minimumTradableNotionalUsd, slippagePercent: Math.min(0.5, networkLimit.maxSlippagePercent), leverage: plan.leverage, side: input.action, settings });
        const estimatedFeeUsd = plan.notionalUsd * 0.00035;
        assertNetworkFeeLimit({ chainId: "hyperliquid", tradeUsd: plan.notionalUsd, venueFeeUsd: estimatedFeeUsd, settings });
        const requiredCapitalUsd = hypercoreRequiredCapitalUsd(plan.notionalUsd, plan.leverage, 0.00035);
        const minimumExecutableExposureUsd = hypercoreRequiredCapitalUsd(
          plan.minimumTradableNotionalUsd,
          plan.leverage,
          0.00035,
        );
        if (mode === "shadow") await assertShadowPortfolioRisk({
          chainId: "hyperliquid",
          assetKey,
          walletId: null,
          side: input.action === "open" ? "buy" : "sell",
          estimatedTradeUsd: requiredCapitalUsd,
          minimumExecutableExposureUsd,
        });
        if (mode === "live") await assertLiveDailyLossLimit("hyperliquid", {
          assetKey,
          walletId: null,
          side: input.action === "open" ? "buy" : "sell",
          estimatedTradeUsd: requiredCapitalUsd,
          minimumExecutableExposureUsd,
        });
        const simulationStartedAt = performance.now();
        const execution = mode === "shadow" ? await hypercoreExecutionAdapter.simulate(plan) : await runLiveSubmission(requestId, (hooks) => hypercoreExecutionAdapter.execute(plan, hooks));
        if (mode === "live" && execution.status !== "confirmed") throw new Error("HyperCore IOC emri tamamen fill olmadı; yerel pozisyon değiştirilmedi.");
        const simulationLatencyMs = Math.round(performance.now() - simulationStartedAt);
        const executionPriceUsd = execution.averagePriceUsd ?? Number(plan.limitPrice);
        const feeUsd = execution.executionFeeUsd ?? estimatedFeeUsd;
        store.updateExecutionAttempt(requestId, {
          status: mode === "shadow" ? "simulated" : "confirmed", amountIn: execution.executedAmount, amountOut: execution.receivedAmount,
          expectedAmountOut: plan.size, minimumAmountOut: plan.size, quotedPriceUsd: Number(plan.limitPrice),
          slippagePercent: 0.5, priceImpactPercent: 0, networkFeeUsd: 0, dexFeeUsd: feeUsd,
          availableBalanceUsd: mode === "shadow" ? store.getShadowAccount("hyperliquid")?.cashBalanceUsd ?? 0 : plan.availableCollateralUsd,
          simulationLatencyMs, metadata: {
            ...quoteGuard,
            assetPolicy,
            assetId: plan.assetId,
            reduceOnly: plan.reduceOnly,
            leverage: plan.leverage,
            marketType: plan.marketType,
            minimumTradableNotionalUsd: plan.minimumTradableNotionalUsd,
            averageFillPriceUsd: execution.averagePriceUsd ?? null,
            actualExecutionFeeUsd: execution.executionFeeUsd ?? null,
          },
          txHash: execution.externalOrderId ? `hyperliquid:${execution.externalOrderId}` : null,
          externalOrderId: execution.externalOrderId,
        });
        if (input.action === "open") {
          const now = new Date().toISOString();
          const entryCostUsd = hypercoreRequiredCapitalUsd(
            Number(execution.executedAmount) * executionPriceUsd,
            plan.leverage,
            0,
          ) + feeUsd;
          store.insertExecutionLot({
            id: crypto.randomUUID(), integrationId: "hyperliquid", mode, assetKey, walletId: null,
            source: "manual", marketType: input.marketType, positionSide: input.positionSide,
            amount: plan.marketType === "spot" ? execution.receivedAmount : execution.executedAmount, amountFormat: "decimal", entryReference: execution.externalOrderId,
            assetSymbol: input.coin, entryPriceUsd: executionPriceUsd, currentPriceUsd: executionPriceUsd,
            entryCostUsd, feesUsd: feeUsd, leverage: plan.leverage,
            status: "open", openedAt: now, updatedAt: now,
          });
          if (mode === "shadow") applyShadowBuy("hyperliquid", entryCostUsd, feeUsd);
        } else {
          const costBasisUsd = consumedCost(openLots, execution.executedAmount);
          const pnlUsd = closePnl(openLots, Number(execution.executedAmount), executionPriceUsd, input.positionSide);
          const netProceedsUsd = Math.max(0, costBasisUsd + pnlUsd - feeUsd);
          store.reduceExecutionLots(openLots, execution.executedAmount, { netProceedsUsd, feesUsd: feeUsd }, 10 ** -plan.sizeDecimals);
          if (mode === "shadow") applyShadowSell("hyperliquid", netProceedsUsd, netProceedsUsd - costBasisUsd, feeUsd);
        }
        store.markExecutionAccounted(requestId);
        if (mode === "live") await reconcileAfterLiveExecution("hyperliquid", requestId);
        await publishEmergencyExitDeviation({ chainId: "hyperliquid", asset: input.coin, assessment: quoteGuard, settings });
        await publishEvent({ chainId: "hyperliquid", level: "info", type: "swap", title: mode === "live" ? "Canlı HyperCore emri tamamlandı" : "Shadow HyperCore emri hazırlandı", message: `${input.coin} ${input.action === "open" ? "açılış" : "kapatma"} emri ${mode === "live" ? execution.status : "imzalanmadan simüle edildi"}.`, txHash: null });
        return NextResponse.json({ execution: { requestId, mode, status: execution.status, orderId: execution.externalOrderId } });
      } catch (error) {
        recordExecutionFailure(requestId, error);
        throw error;
      }
    }
    const trade = await executeHypercoreManualTrade(input);
    return NextResponse.json({ trade });
  } catch (error) {
    return apiError(error);
  }
}

function closePnl(lots: ReturnType<typeof store.getOpenExecutionLots>, quantity: number, closePriceUsd: number, side: "long" | "short") {
  let remaining = quantity;
  let pnl = 0;
  for (const lot of lots) {
    if (remaining <= 0) break;
    const consumed = Math.min(Number(lot.amount), remaining);
    pnl += (side === "short" ? -1 : 1) * (closePriceUsd - lot.entryPriceUsd) * consumed;
    remaining -= consumed;
  }
  return pnl;
}
