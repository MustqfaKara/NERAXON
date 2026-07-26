import type { HypercoreFillObservation, HypercorePositionSide, TrackedWallet } from "@/lib/domain/types";
import { hypercoreExecutionAdapter } from "@/lib/execution/hypercore-execution-adapter";
import { store } from "@/lib/repositories/store";
import { publishEvent } from "@/lib/services/audit-service";
import { getHypercoreUserLeverage } from "@/lib/services/hypercore-api";
import { copyAllocationPercent, resolveOwnedDecimalClose, sumDecimalLots } from "@/lib/execution/execution-lot-math";
import { reconcileAfterLiveExecution } from "@/lib/services/live-certification";
import { assertLiveDailyLossLimit } from "@/lib/services/live-equity";
import { applyShadowBuy, applyShadowSell, assertShadowPortfolioRisk, consumedCost } from "@/lib/services/execution-accounting";
import { hypercoreRequiredCapitalUsd } from "@/lib/execution/hypercore-execution-math";
import { assertNetworkFeeLimit } from "@/lib/execution/network-fee-guard";
import { assertNetworkExecutionLimit, getNetworkExecutionLimit } from "@/lib/execution/network-execution-risk";
import { assertPriceDeviation, prepareFreshQuote } from "@/lib/execution/execution-quote-guard";
import { assertAssetExecutionPolicy } from "@/lib/engine/asset-execution-policy";
import { claimExecutionAttempt, createCopyExecutionKey, recordExecutionFailure, runLiveSubmission } from "@/lib/services/execution-lifecycle";
import { isWalletEligibleForCopy } from "@/lib/engine/wallet-copy-eligibility";
import { queueTradeAdvisory } from "@/lib/services/ai-trade-advisor";

export async function executeHypercoreCopyExecution(wallet: TrackedWallet, fill: HypercoreFillObservation) {
  if (!isWalletEligibleForCopy(wallet.state)) return null;
  const mode = store.getMode();
  if (mode === "paper") throw new Error("Paper fill canlı HyperCore yürütücüsüne gönderilemez.");
  const intent = resolveIntent(fill);
  if (!intent) throw new Error("HyperCore pozisyon yönü güvenle çözümlenemedi; flip işlemi kopyalanmadı.");
  const assetKey = `${fill.marketType}:${fill.coin}`.toLowerCase();
  const consensus = intent.action === "open" ? store.registerExecutionBuySignal(mode, "hyperliquid", assetKey, wallet.id, fill.id) : null;
  if (consensus && !consensus.shouldCopy) {
    store.recordWalletObservation(wallet.id, "swap", false);
    const message = consensus.reason === "duplicate_wallet"
      ? `${wallet.label} bu piyasa için daha önce sayıldığı için tekrar eden giriş sinyali konsensüse eklenmedi.`
      : consensus.reason === "stage_pending"
        ? `${fill.coin} için önceki ${mode} giriş aşaması sonuçlanıyor; çift emir engellendi.`
        : `${consensus.distinctWalletCount} farklı cüzdan görüldü; sonraki ${mode} giriş eşiği ${consensus.requiredWalletCount} cüzdan.`;
    await publishEvent({ chainId: "hyperliquid", level: "info", type: "swap", title: `${fill.coin} konsensüs bekliyor`, message, txHash: fill.id });
    return null;
  }

  const ownedLots = store.getOpenExecutionLots({ integrationId: "hyperliquid", mode, assetKey, walletId: wallet.id, positionSide: intent.side });
  const ownedQuantity = sumDecimalLots(ownedLots.map((lot) => lot.amount));
  if (intent.action === "close" && ownedQuantity <= 0) {
    await publishEvent({ chainId: "hyperliquid", level: "warning", type: "swap", title: `${fill.coin} çıkışı atlandı`, message: `${wallet.label} cüzdanına ait açık ${mode} lotu bulunamadı.`, txHash: fill.id });
    store.recordWalletObservation(wallet.id, "swap", false);
    return null;
  }

  const requestId = `copy:${mode}:hyperliquid:${fill.id}`;
  const idempotencyKey = createCopyExecutionKey(mode, "hyperliquid", fill.id);
  const claim = claimExecutionAttempt({ requestId, idempotencyKey, integrationId: "hyperliquid", walletId: wallet.id, mode, source: "copy", action: intent.action, asset: fill.coin });
  if (!claim.created) return null;
  try {
    const settings = store.getRiskSettings();
    const networkLimit = getNetworkExecutionLimit("hyperliquid", settings);
    const allocationPercent = copyAllocationPercent(wallet.score, networkLimit.minPositionPercent, networkLimit.maxPositionPercent);
    const sourceLeverage = fill.marketType === "spot" ? 1 : await getHypercoreUserLeverage(fill.walletAddress, fill.coin).catch(() => 1);
    const leverage = fill.marketType === "spot" ? 1 : Math.max(1, Math.min(networkLimit.maxLeverage, sourceLeverage));
    const exactCloseQuantity = intent.action === "close" ? resolveOwnedDecimalClose(fill.quantity, ownedLots.map((lot) => lot.amount)) : undefined;
    const executionIntent = {
      coin: fill.coin,
      marketType: fill.marketType,
      positionSide: intent.side,
      action: intent.action,
      allocationPercent,
      exactCloseQuantity,
      leverage,
      slippagePercent: Math.min(0.5, networkLimit.maxSlippagePercent),
      mode,
    } as const;
    const prepared = await prepareFreshQuote({ chainId: "hyperliquid", settings, prepare: () => hypercoreExecutionAdapter.prepare(executionIntent), quotedAt: (current) => current.quotedAt });
    const plan = prepared.plan;
    const assetPolicy = assertAssetExecutionPolicy({ chainId: "hyperliquid", asset: assetKey, opensPosition: intent.action === "open", settings, marketType: plan.marketType, volume24hUsd: plan.volume24hUsd, openInterestUsd: plan.openInterestUsd });
    queueTradeAdvisory({
      chainId: "hyperliquid",
      mode,
      side: intent.action === "open" ? "buy" : "sell",
      asset: fill.coin,
      walletId: wallet.id,
      walletLabel: wallet.label,
      walletScore: wallet.score,
      walletConfirmations: consensus?.distinctWalletCount ?? 1,
      priceUsd: plan.referencePriceUsd,
      priceChange24hPercent: 0,
      liquidityUsd: plan.openInterestUsd,
      volume24hUsd: plan.volume24hUsd,
      marketCapUsd: null,
      safetyScore: assetPolicy.approved ? 100 : 0,
      safetyWarnings: assetPolicy.checks.filter((check) => check.status === "warning").map((check) => check.detail),
      sourceReference: fill.id,
    });
    const quoteGuard = assertPriceDeviation({ chainId: "hyperliquid", side: intent.action === "open" ? "buy" : "sell", referencePriceUsd: plan.referencePriceUsd, quotedPriceUsd: Number(plan.limitPrice), quotedAt: plan.quotedAt, quoteRefreshed: prepared.quoteRefreshed, settings });
    assertNetworkExecutionLimit({ chainId: "hyperliquid", tradeUsd: plan.notionalUsd, minimumTradableNotionalUsd: plan.minimumTradableNotionalUsd, slippagePercent: Math.min(0.5, networkLimit.maxSlippagePercent), leverage: plan.leverage, side: intent.action, settings });
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
      walletId: wallet.id,
      side: intent.action === "open" ? "buy" : "sell",
      estimatedTradeUsd: requiredCapitalUsd,
      minimumExecutableExposureUsd,
    });
    if (mode === "live") await assertLiveDailyLossLimit("hyperliquid", {
      assetKey,
      walletId: wallet.id,
      side: intent.action === "open" ? "buy" : "sell",
      estimatedTradeUsd: requiredCapitalUsd,
      minimumExecutableExposureUsd,
    });
    const simulationStartedAt = performance.now();
    const execution = mode === "shadow" ? await hypercoreExecutionAdapter.simulate(plan) : await runLiveSubmission(requestId, (hooks) => hypercoreExecutionAdapter.execute(plan, hooks));
    if (mode === "live" && execution.status !== "confirmed") throw new Error("HyperCore IOC copy emri tamamen fill olmadı; yerel lot değiştirilmedi.");
    const simulationLatencyMs = Math.round(performance.now() - simulationStartedAt);
    const executedQuantity = Number(execution.executedAmount);
    const openedQuantity = plan.marketType === "spot" ? Number(execution.receivedAmount) : executedQuantity;
    const executionPriceUsd = execution.averagePriceUsd ?? Number(plan.limitPrice);
    const feeUsd = execution.executionFeeUsd ?? estimatedFeeUsd;
    store.updateExecutionAttempt(requestId, {
      status: mode === "shadow" ? "simulated" : "confirmed", amountIn: execution.executedAmount, amountOut: execution.receivedAmount,
      expectedAmountOut: plan.size, minimumAmountOut: plan.size, quotedPriceUsd: Number(plan.limitPrice),
      slippagePercent: Math.min(0.5, settings.maxSlippagePercent), priceImpactPercent: Math.abs(Number(plan.limitPrice) / fill.priceUsd - 1) * 100,
      networkFeeUsd: 0, dexFeeUsd: feeUsd, availableBalanceUsd: mode === "shadow" ? store.getShadowAccount("hyperliquid")?.cashBalanceUsd ?? 0 : plan.availableCollateralUsd,
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
    if (intent.action === "open") {
      const now = new Date().toISOString();
      const entryCostUsd = hypercoreRequiredCapitalUsd(executedQuantity * executionPriceUsd, plan.leverage, 0)
        + feeUsd;
      store.insertExecutionLot({
        id: crypto.randomUUID(), integrationId: "hyperliquid", mode, assetKey, walletId: wallet.id, source: "copy",
        marketType: fill.marketType, positionSide: intent.side, amount: String(openedQuantity), amountFormat: "decimal",
        assetSymbol: fill.coin, assetDecimals: 0, entryPriceUsd: executionPriceUsd, currentPriceUsd: executionPriceUsd,
        entryCostUsd, feesUsd: feeUsd, leverage: plan.leverage,
        entryReference: execution.externalOrderId ?? fill.id, status: "open", openedAt: now, updatedAt: now,
      });
      if (mode === "shadow") applyShadowBuy("hyperliquid", entryCostUsd, feeUsd);
      if (consensus?.shouldCopy) store.finishExecutionBuyStage(mode, "hyperliquid", assetKey, consensus.stage, true);
    } else {
      const costBasisUsd = consumedCost(ownedLots, String(executedQuantity));
      const pnlUsd = hypercoreClosePnl(ownedLots, executedQuantity, executionPriceUsd, intent.side);
      const netProceedsUsd = Math.max(0, costBasisUsd + pnlUsd - feeUsd);
      store.reduceExecutionLots(ownedLots, String(executedQuantity), { netProceedsUsd, feesUsd: feeUsd }, 10 ** -plan.sizeDecimals);
      if (mode === "shadow") applyShadowSell("hyperliquid", netProceedsUsd, netProceedsUsd - costBasisUsd, feeUsd);
    }
    store.markExecutionAccounted(requestId);
    if (mode === "live") await reconcileAfterLiveExecution("hyperliquid", requestId);
    store.recordWalletObservation(wallet.id, "swap", true);
    await publishEvent({
      chainId: "hyperliquid", level: "info", type: "swap",
      title: `${fill.coin} ${mode} HyperCore copy trade`,
      message: `${wallet.label} kaynaklı ${intent.action === "open" ? "giriş" : "çıkış"} ${mode === "live" ? "borsada onaylandı" : "imzalanmadan simüle edildi"}.`,
      txHash: fill.id,
    });
    return execution;
  } catch (error) {
    if (consensus?.shouldCopy) store.finishExecutionBuyStage(mode, "hyperliquid", assetKey, consensus.stage, false, wallet.id);
    recordExecutionFailure(requestId, error);
    store.recordWalletObservation(wallet.id, "swap", false);
    throw error;
  }
}

function hypercoreClosePnl(lots: ReturnType<typeof store.getOpenExecutionLots>, quantity: number, closePriceUsd: number, side: HypercorePositionSide) {
  let remaining = quantity;
  let pnl = 0;
  for (const lot of lots) {
    if (remaining <= 0) break;
    const consumed = Math.min(Number(lot.amount), remaining);
    const direction = side === "short" ? -1 : 1;
    pnl += direction * (closePriceUsd - lot.entryPriceUsd) * consumed;
    remaining -= consumed;
  }
  return pnl;
}

function resolveIntent(fill: HypercoreFillObservation): { action: "open" | "close"; side: HypercorePositionSide } | null {
  if (fill.marketType === "spot") return { action: fill.side === "buy" ? "open" : "close", side: "long" };
  const direction = fill.direction.toLowerCase();
  if (direction.includes(">")) return null;
  return { action: direction.includes("close") ? "close" : "open", side: direction.includes("short") ? "short" : "long" };
}
