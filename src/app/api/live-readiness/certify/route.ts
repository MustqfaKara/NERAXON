import { NextResponse } from "next/server";
import { formatUnits, getAddress, isAddress } from "viem";
import { z } from "zod";
import { getEvmExecutionAdapter } from "@/lib/execution/evm-execution-adapter";
import { hypercoreExecutionAdapter } from "@/lib/execution/hypercore-execution-adapter";
import { assertEvmExecutionRisk } from "@/lib/execution/live-execution-guard";
import { store } from "@/lib/repositories/store";
import { assertSameOrigin } from "@/lib/security/same-origin";
import { reconcileAfterLiveExecution, requiredCertificationSteps } from "@/lib/services/live-certification";
import { resolveTokenQuote } from "@/lib/services/token-quote-service";
import { apiError } from "@/lib/utils/api";
import { assertLiveDailyLossLimit } from "@/lib/services/live-equity";
import { publishEvent } from "@/lib/services/audit-service";
import { PublicKey } from "@solana/web3.js";
import { solanaExecutionAdapter } from "@/lib/execution/solana-execution-adapter";
import { assertNetworkFeeLimit } from "@/lib/execution/network-fee-guard";
import { estimateSolanaNetworkFeeLamports, estimateSolanaRouteFeeUsd } from "@/lib/execution/solana-fee";
import { dexFeePercentFor } from "@/lib/engine/paper-execution-model";
import { getMarketDataProvider } from "@/lib/services/market-data-provider";
import { SOLANA_LAMPORTS_PER_SOL, SOLANA_NATIVE_MINT } from "@/lib/solana/constants";
import { assertNetworkExecutionLimit, getNetworkExecutionLimit } from "@/lib/execution/network-execution-risk";
import { assertPriceDeviation, prepareFreshQuote } from "@/lib/execution/execution-quote-guard";
import { assertAssetExecutionPolicy } from "@/lib/engine/asset-execution-policy";
import { verifyEvmExitRoute, verifySolanaExitRoute } from "@/lib/services/exit-route-verifier";
import { claimExecutionAttempt, createManualExecutionKey, recordExecutionFailure, runLiveSubmission } from "@/lib/services/execution-lifecycle";
import { isLivePilotIntegration } from "@/lib/domain/integrations";
import { ensureHypercorePerpCollateral } from "@/lib/execution/hypercore-live-execution";
import { hypercoreRequiredCapitalUsd } from "@/lib/execution/hypercore-execution-math";
import { consumedCost } from "@/lib/services/execution-accounting";

const schema = z.object({
  chainId: z.enum(["ethereum", "base", "robinhood", "solana", "hyperliquid"]),
  stepId: z.string().min(1),
  tokenAddress: z.string().optional(),
  coin: z.string().min(1).max(40).optional(),
  positionSide: z.enum(["long", "short"]).optional(),
  allocationPercent: z.number().min(5).max(20).default(20),
  confirmation: z.literal("NERAXON TEST"),
});

export async function POST(request: Request) {
  let parsed: z.infer<typeof schema> | null = null;
  let requestId: string | null = null;
  try {
    assertSameOrigin(request);
    parsed = schema.parse(await request.json());
    assertCertificationEnvironment(parsed.chainId, parsed.stepId);
    requestId = crypto.randomUUID();
    const asset = parsed.chainId === "hyperliquid" ? `${parsed.stepId.startsWith("spot_") ? "spot" : "perp"}:${parsed.coin ?? "unknown"}` : parsed.tokenAddress ?? "unknown";
    const confirmedAttempt = store.listExecutionAttempts().find((attempt) => (
      attempt.integrationId === parsed!.chainId
      && attempt.mode === "live"
      && attempt.source === "certification"
      && attempt.action === parsed!.stepId
      && sameCertificationAsset(parsed!.chainId, attempt.asset, asset)
      && attempt.status === "confirmed"
      && attempt.accountingStatus === "applied"
      && Boolean(attempt.txHash ?? attempt.externalOrderId)
    ));
    if (confirmedAttempt) {
      const reconciliation = await reconcileAfterLiveExecution(parsed.chainId, confirmedAttempt.requestId);
      const reference = confirmedAttempt.txHash ?? confirmedAttempt.externalOrderId!;
      store.setCertificationStep({ integrationId: parsed.chainId, stepId: parsed.stepId, status: "passed", reference, details: `Önceden onaylanan gerçek mikro işlem yeniden gönderilmeden mutabık kılındı. ${reconciliation.details}`, checkedAt: new Date().toISOString() });
      return NextResponse.json({ stepId: parsed.stepId, status: "passed", reference, reconciliation, recovered: true });
    }
    const idempotencyKey = createManualExecutionKey({ mode: "live", chainId: parsed.chainId, action: `certification:${parsed.stepId}`, asset, allocationPercent: parsed.allocationPercent, positionSide: parsed.positionSide });
    const claim = claimExecutionAttempt({ requestId, idempotencyKey, integrationId: parsed.chainId, mode: "live", source: "certification", action: parsed.stepId, asset });
    if (!claim.created) {
      if (claim.attempt.status === "confirmed" && claim.attempt.accountingStatus === "applied") {
        const reconciliation = await reconcileAfterLiveExecution(parsed.chainId, claim.attempt.requestId);
        const reference = claim.attempt.txHash ?? claim.attempt.externalOrderId;
        if (!reference) throw new Error("Onaylı sertifika işleminin ağ referansı bulunamadı.");
        store.setCertificationStep({ integrationId: parsed.chainId, stepId: parsed.stepId, status: "passed", reference, details: `Önceden onaylanan gerçek mikro işlem yeniden gönderilmeden mutabık kılındı. ${reconciliation.details}`, checkedAt: new Date().toISOString() });
        return NextResponse.json({ stepId: parsed.stepId, status: "passed", reference, reconciliation, recovered: true });
      }
      return NextResponse.json({ stepId: parsed.stepId, duplicate: true, execution: claim.attempt });
    }
    const reference = parsed.chainId === "hyperliquid" ? await runHypercoreStep(parsed, requestId) : parsed.chainId === "solana" ? await runSolanaStep(parsed, requestId) : await runEvmStep(parsed, requestId);
    const reconciliation = await reconcileAfterLiveExecution(parsed.chainId, requestId);
    store.setCertificationStep({ integrationId: parsed.chainId, stepId: parsed.stepId, status: "passed", reference, details: `Gerçek mikro işlem ve mutabakat tamamlandı. ${reconciliation.details}`, checkedAt: new Date().toISOString() });
    await publishEvent({ chainId: parsed.chainId, level: "info", type: "swap", title: "Canlı hazırlık testi geçti", message: `${parsed.stepId} gerçek mikro işlemi ve mutabakatı tamamlandı.`, txHash: parsed.chainId === "hyperliquid" ? null : reference });
    return NextResponse.json({ stepId: parsed.stepId, status: "passed", reference, reconciliation });
  } catch (error) {
    if (requestId) recordExecutionFailure(requestId, error);
    if (parsed && requiredCertificationSteps(parsed.chainId).includes(parsed.stepId as never)) {
      store.setCertificationStep({ integrationId: parsed.chainId, stepId: parsed.stepId, status: "failed", reference: null, details: error instanceof Error ? error.message : "Canlı test başarısız.", checkedAt: new Date().toISOString() });
      await publishEvent({ chainId: parsed.chainId, level: "critical", type: "system", title: "Canlı hazırlık testi başarısız", message: `${parsed.stepId}: ${error instanceof Error ? error.message : "Bilinmeyen hata"}`, txHash: null });
    }
    return apiError(error);
  }
}

function sameCertificationAsset(chainId: z.infer<typeof schema>["chainId"], left: string, right: string) {
  return chainId === "solana" ? left === right : left.toLowerCase() === right.toLowerCase();
}

function assertCertificationEnvironment(chainId: z.infer<typeof schema>["chainId"], stepId: string) {
  if (!isLivePilotIntegration(chainId)) throw new Error("Bu ağ ilk canlı pilot kapsamına dahil değil.");
  const required = requiredCertificationSteps(chainId);
  if (!required.includes(stepId as never)) throw new Error("Bu ağ için geçersiz canlı test adımı.");
  const stepIndex = required.indexOf(stepId as never);
  const passed = new Set(store.listCertificationSteps().filter((step) => step.integrationId === chainId && step.status === "passed").map((step) => step.stepId));
  const missingPrevious = required.slice(0, stepIndex).find((requiredStep) => !passed.has(requiredStep));
  const hasOpenCertificationLot = store.listExecutionLots("live", chainId).some((lot) => lot.status === "open" && lot.source === "certification");
  const emergencyClose = stepId.endsWith("close") && hasOpenCertificationLot;
  if (missingPrevious && !emergencyClose) throw new Error(`Önce ${missingPrevious} canlı test adımı tamamlanmalı.`);
  if (store.getMode() !== "live") throw new Error("Canlı mikro testler yalnızca live modda çalıştırılabilir.");
  if (store.listChains().some((chain) => chain.status !== "stopped")) throw new Error("Canlı test öncesinde bütün ağ botları durdurulmalı.");
  if (store.getCircuitBreaker().halted) throw new Error("Devre kesici aktifken canlı test çalıştırılamaz.");
  if (process.env.LIVE_TRADING_ENABLED?.toLowerCase() !== "true") throw new Error("LIVE_TRADING_ENABLED=true olmadan gerçek test emri gönderilemez.");
}

async function runEvmStep(input: z.infer<typeof schema>, requestId: string) {
  if (input.chainId === "hyperliquid" || input.chainId === "solana") throw new Error("Bu adım EVM testine gönderilemez.");
  if (!input.tokenAddress || !isAddress(input.tokenAddress)) throw new Error("EVM testi için geçerli token kontratı gerekli.");
  const tokenAddress = getAddress(input.tokenAddress);
  const adapter = getEvmExecutionAdapter(input.chainId);
  const settings = store.getRiskSettings();
  const quote = await resolveTokenQuote(input.chainId, tokenAddress);
  const lots = store.listExecutionLots("live", input.chainId).filter((lot) => lot.status === "open" && lot.source === "certification" && lot.assetKey.toLowerCase() === tokenAddress.toLowerCase());
  const total = lots.reduce((sum, lot) => sum + BigInt(lot.amount), 0n);
  const side = input.stepId === "small_buy" ? "buy" : "sell";
  const exactSellAmount = input.stepId === "partial_sell" ? total / 2n : input.stepId === "full_sell" ? total : undefined;
  if (side === "sell" && (!exactSellAmount || exactSellAmount <= 0n)) throw new Error("Önce küçük alım testi tamamlanmalı.");
  const intent = { chainId: input.chainId, side, tokenAddress, allocationPercent: input.allocationPercent, exactSellAmount, slippagePercent: Math.min(0.5, settings.maxSlippagePercent), mode: "live" } as const;
  const prepared = await prepareFreshQuote({ chainId: input.chainId, settings, prepare: () => adapter.prepare(intent), quotedAt: (current) => current.quotedAt });
  const plan = prepared.plan;
  const youngMarket = Boolean(quote.market.pairCreatedAt && Date.now() - quote.market.pairCreatedAt < settings.assetPolicy!.youngPoolAgeMinutes * 60_000);
  assertAssetExecutionPolicy({ chainId: input.chainId, asset: tokenAddress, opensPosition: side === "buy", settings, safety: quote.safety, market: quote.market, walletConfirmations: 0, exitRouteVerified: side === "buy" && youngMarket ? await verifyEvmExitRoute(plan) : true });
  const estimatedTradeUsd = side === "sell" ? Number(formatUnits(plan.sellAmount, quote.decimals)) * quote.market.priceUsd : undefined;
  const risk = await assertEvmExecutionRisk({ chainId: input.chainId, plan, settings, estimatedTradeUsd });
  const quotedTokenQuantity = Number(formatUnits(side === "buy" ? plan.buyAmount : plan.sellAmount, quote.decimals));
  assertPriceDeviation({ chainId: input.chainId, side, referencePriceUsd: quote.market.priceUsd, quotedPriceUsd: quotedTokenQuantity > 0 ? risk.estimatedTradeUsd / quotedTokenQuantity : 0, quotedAt: plan.quotedAt, quoteRefreshed: prepared.quoteRefreshed, emergencyExit: side === "sell" && input.stepId === "full_sell", settings });
  const venueFeeUsd = risk.estimatedTradeUsd * dexFeePercentFor(quote.market.dexId) / 100;
  assertNetworkExecutionLimit({ chainId: input.chainId, tradeUsd: risk.estimatedTradeUsd, slippagePercent: Math.min(0.5, getNetworkExecutionLimit(input.chainId, settings).maxSlippagePercent), side, settings });
  assertNetworkFeeLimit({ chainId: input.chainId, tradeUsd: risk.estimatedTradeUsd, networkFeeUsd: risk.gasFeeUsd, venueFeeUsd, settings });
  await assertLiveDailyLossLimit(input.chainId);
  const execution = await runLiveSubmission(requestId, (hooks) => adapter.execute(plan, hooks));
  if (execution.status !== "confirmed" || !execution.txHash) throw new Error("EVM test işlemi zincirde confirmed olmadı.");
  store.updateExecutionAttempt(requestId, {
    status: "confirmed",
    amountIn: execution.executedAmount,
    amountOut: execution.receivedAmount,
    expectedAmountOut: plan.buyAmount.toString(),
    minimumAmountOut: plan.minBuyAmount.toString(),
    networkFeeUsd: risk.gasFeeUsd,
    dexFeeUsd: venueFeeUsd,
    metadata: {
      tradeValueUsd: risk.estimatedTradeUsd,
      estimatedNetworkFeeUsd: risk.gasFeeUsd,
      estimatedVenueFeeUsd: venueFeeUsd,
    },
    txHash: execution.txHash,
    externalOrderId: execution.externalOrderId,
  });
  if (side === "buy") {
    const now = new Date().toISOString();
    store.insertExecutionLot({ id: crypto.randomUUID(), integrationId: input.chainId, mode: "live", assetKey: tokenAddress.toLowerCase(), walletId: null, source: "certification", marketType: "evm", positionSide: null, amount: execution.receivedAmount, amountFormat: "base_units", entryReference: execution.txHash, status: "open", openedAt: now, updatedAt: now });
  } else {
    store.reduceExecutionLots(lots, execution.executedAmount);
  }
  store.markExecutionAccounted(requestId);
  return execution.txHash;
}

async function runSolanaStep(input: z.infer<typeof schema>, requestId: string) {
  if (input.chainId !== "solana" || !input.tokenAddress) throw new Error("Solana testi için token mint adresi gerekli.");
  let tokenAddress: string;
  try { tokenAddress = new PublicKey(input.tokenAddress).toBase58(); } catch { throw new Error("Solana testi için geçerli token mint adresi gerekli."); }
  const quote = await resolveTokenQuote("solana", tokenAddress);
  const lots = store.listExecutionLots("live", "solana").filter((lot) => lot.status === "open" && lot.source === "certification" && lot.assetKey === tokenAddress);
  const total = lots.reduce((sum, lot) => sum + BigInt(lot.amount), 0n);
  const side = input.stepId === "small_buy" ? "buy" : "sell";
  const exactSellAmount = input.stepId === "partial_sell" ? total / 2n : input.stepId === "full_sell" ? total : undefined;
  if (side === "sell" && (!exactSellAmount || exactSellAmount <= 0n)) throw new Error("Önce küçük Solana alım testi tamamlanmalı.");
  const settings = store.getRiskSettings();
  const intent = { side, tokenAddress, allocationPercent: input.allocationPercent, exactSellAmount, slippagePercent: Math.min(0.5, settings.maxSlippagePercent), mode: "live" } as const;
  const prepared = await prepareFreshQuote({ chainId: "solana", settings, prepare: () => solanaExecutionAdapter.prepare(intent), quotedAt: (current) => current.quotedAt });
  const plan = prepared.plan;
  const youngMarket = Boolean(quote.market.pairCreatedAt && Date.now() - quote.market.pairCreatedAt < settings.assetPolicy!.youngPoolAgeMinutes * 60_000);
  assertAssetExecutionPolicy({ chainId: "solana", asset: tokenAddress, opensPosition: side === "buy", settings, safety: quote.safety, market: quote.market, walletConfirmations: 0, exitRouteVerified: side === "buy" && youngMarket ? await verifySolanaExitRoute(plan) : true });
  if (Number(plan.quote.priceImpactPct) * 100 > settings.maxPriceImpactPercent) throw new Error("Jupiter rota fiyat etkisi test sınırını aşıyor.");
  const nativeMarket = await getMarketDataProvider().getTokenMarket("solana", SOLANA_NATIVE_MINT);
  const tradeUsd = side === "buy"
    ? Number(plan.quote.inAmount) / SOLANA_LAMPORTS_PER_SOL * nativeMarket.priceUsd
    : Number(plan.quote.outAmount) / SOLANA_LAMPORTS_PER_SOL * nativeMarket.priceUsd;
  const quotedTokenQuantity = Number(formatUnits(BigInt(side === "buy" ? plan.quote.outAmount : plan.quote.inAmount), quote.decimals));
  assertPriceDeviation({ chainId: "solana", side, referencePriceUsd: quote.market.priceUsd, quotedPriceUsd: quotedTokenQuantity > 0 ? tradeUsd / quotedTokenQuantity : 0, quotedAt: plan.quotedAt, quoteRefreshed: prepared.quoteRefreshed, emergencyExit: side === "sell" && input.stepId === "full_sell", settings });
  assertNetworkExecutionLimit({ chainId: "solana", tradeUsd, slippagePercent: plan.quote.slippageBps / 100, side, settings });
  const estimatedNetworkFeeUsd = estimateSolanaNetworkFeeLamports(plan.estimatedPriorityFeeLamports) / SOLANA_LAMPORTS_PER_SOL * nativeMarket.priceUsd;
  const venueFeeUsd = estimateSolanaRouteFeeUsd(plan.quote, nativeMarket.priceUsd, quote.market.priceUsd, quote.decimals);
  assertNetworkFeeLimit({ chainId: "solana", tradeUsd, networkFeeUsd: estimatedNetworkFeeUsd, venueFeeUsd, settings });
  await assertLiveDailyLossLimit("solana");
  const execution = await runLiveSubmission(requestId, (hooks) => solanaExecutionAdapter.execute(plan, hooks));
  if (execution.status !== "confirmed" || !execution.txHash) throw new Error("Solana test işlemi zincirde confirmed olmadı.");
  const actualNetworkFeeLamports = execution.networkFeeNativeAmount ? Number(execution.networkFeeNativeAmount) : null;
  const refundableRentLamports = execution.refundableRentNativeAmount ? Number(execution.refundableRentNativeAmount) : 0;
  const networkFeeUsd = actualNetworkFeeLamports === null ? estimatedNetworkFeeUsd : actualNetworkFeeLamports / SOLANA_LAMPORTS_PER_SOL * nativeMarket.priceUsd;
  store.updateExecutionAttempt(requestId, { status: "confirmed", amountIn: execution.executedAmount, amountOut: execution.receivedAmount, expectedAmountOut: plan.quote.outAmount, minimumAmountOut: plan.quote.otherAmountThreshold, networkFeeUsd, dexFeeUsd: venueFeeUsd, metadata: { tradeValueUsd: tradeUsd, estimatedNetworkFeeUsd, actualNetworkFeeLamports, refundableRentLamports, refundableRentDepositUsd: refundableRentLamports / SOLANA_LAMPORTS_PER_SOL * nativeMarket.priceUsd }, txHash: execution.txHash, externalOrderId: execution.externalOrderId });
  if (side === "buy") {
    const now = new Date().toISOString();
    store.insertExecutionLot({ id: crypto.randomUUID(), integrationId: "solana", mode: "live", assetKey: tokenAddress, walletId: null, source: "certification", marketType: "solana", positionSide: null, amount: execution.receivedAmount, amountFormat: "base_units", entryReference: execution.txHash, status: "open", openedAt: now, updatedAt: now });
  } else store.reduceExecutionLots(lots, execution.executedAmount);
  store.markExecutionAccounted(requestId);
  return execution.txHash;
}

async function runHypercoreStep(input: z.infer<typeof schema>, requestId: string) {
  if (!input.coin) throw new Error("HyperCore testi için piyasa sembolü gerekli.");
  const marketType = input.stepId.startsWith("spot_") ? "spot" : "perp";
  const action = input.stepId.endsWith("open") ? "open" : "close";
  const positionSide = marketType === "spot" ? "long" : input.positionSide ?? "long";
  const assetKey = `${marketType}:${input.coin}`.toLowerCase();
  const lots = store.listExecutionLots("live", "hyperliquid").filter((lot) => lot.status === "open" && lot.source === "certification" && lot.assetKey === assetKey && lot.positionSide === positionSide);
  const total = lots.reduce((sum, lot) => sum + Number(lot.amount), 0);
  const exactCloseQuantity = input.stepId === "perp_reduce" ? total / 2 : action === "close" ? total : undefined;
  if (action === "close" && (!exactCloseQuantity || exactCloseQuantity <= 0)) throw new Error("Önce ilgili HyperCore açılış testi tamamlanmalı.");
  const settings = store.getRiskSettings();
  if (input.stepId === "perp_open") {
    const minimumCollateral = getNetworkExecutionLimit("hyperliquid", settings).minTradeUsd;
    const collateral = await ensureHypercorePerpCollateral(minimumCollateral);
    if (collateral.transferredUsd > 0) {
      await publishEvent({ chainId: "hyperliquid", level: "warning", type: "system", title: "HyperCore perp teminatı hazırlandı", message: `${collateral.transferredUsd.toFixed(2)} USDC spot hesaptan perp hesabına aktarıldı.`, txHash: null });
    }
  }
  const reduceCertificationRange = input.stepId === "perp_open" ? { target: 21.75, min: 21.5, max: 22.5 } : undefined;
  const intent = { coin: input.coin, marketType, positionSide, action, allocationPercent: input.allocationPercent, exactCloseQuantity, leverage: input.stepId === "perp_open" ? 2 : marketType === "perp" ? 1 : undefined, slippagePercent: 0.25, mode: "live", certificationNotionalUsd: reduceCertificationRange } as const;
  const prepared = await prepareFreshQuote({ chainId: "hyperliquid", settings, prepare: () => hypercoreExecutionAdapter.prepare(intent), quotedAt: (current) => current.quotedAt });
  const plan = prepared.plan;
  assertAssetExecutionPolicy({ chainId: "hyperliquid", asset: assetKey, opensPosition: action === "open", settings, marketType: plan.marketType, volume24hUsd: plan.volume24hUsd, openInterestUsd: plan.openInterestUsd });
  assertPriceDeviation({ chainId: "hyperliquid", side: action === "open" ? "buy" : "sell", referencePriceUsd: plan.referencePriceUsd, quotedPriceUsd: Number(plan.limitPrice), quotedAt: plan.quotedAt, quoteRefreshed: prepared.quoteRefreshed, emergencyExit: action === "close" && !input.stepId.includes("reduce"), settings });
  const riskSettings = reduceCertificationRange ? {
    ...settings,
    networkExecutionLimits: {
      ...settings.networkExecutionLimits!,
      hyperliquid: { ...settings.networkExecutionLimits!.hyperliquid, maxTradeUsd: reduceCertificationRange.max },
    },
  } : settings;
  assertNetworkExecutionLimit({ chainId: "hyperliquid", tradeUsd: plan.notionalUsd, minimumTradableNotionalUsd: plan.minimumTradableNotionalUsd, slippagePercent: 0.25, leverage: plan.leverage, side: action, settings: riskSettings });
  const estimatedFeeUsd = plan.notionalUsd * 0.00035;
  assertNetworkFeeLimit({ chainId: "hyperliquid", tradeUsd: plan.notionalUsd, venueFeeUsd: estimatedFeeUsd, settings });
  await assertLiveDailyLossLimit("hyperliquid");
  const execution = await runLiveSubmission(requestId, (hooks) => hypercoreExecutionAdapter.execute(plan, hooks));
  if (execution.status !== "confirmed" || !execution.externalOrderId) throw new Error("HyperCore test emri tamamen fill olmadı.");
  const executionPriceUsd = execution.averagePriceUsd ?? Number(plan.limitPrice);
  const feeUsd = execution.executionFeeUsd ?? estimatedFeeUsd;
  store.updateExecutionAttempt(requestId, {
    status: "confirmed",
    amountIn: execution.executedAmount,
    amountOut: execution.receivedAmount,
    expectedAmountOut: plan.size,
    minimumAmountOut: plan.size,
    quotedPriceUsd: Number(plan.limitPrice),
    slippagePercent: 0.25,
    priceImpactPercent: 0,
    networkFeeUsd: 0,
    dexFeeUsd: feeUsd,
    availableBalanceUsd: plan.availableCollateralUsd,
    metadata: {
      assetId: plan.assetId,
      reduceOnly: plan.reduceOnly,
      leverage: plan.leverage,
      marketType: plan.marketType,
      minimumTradableNotionalUsd: plan.minimumTradableNotionalUsd,
      averageFillPriceUsd: execution.averagePriceUsd ?? null,
      actualExecutionFeeUsd: execution.executionFeeUsd ?? null,
    },
    txHash: `hyperliquid:${execution.externalOrderId}`,
    externalOrderId: execution.externalOrderId,
  });
  if (action === "open") {
    const now = new Date().toISOString();
    const entryCostUsd = hypercoreRequiredCapitalUsd(
      Number(execution.executedAmount) * executionPriceUsd,
      plan.leverage,
      0,
    ) + feeUsd;
    store.insertExecutionLot({
      id: crypto.randomUUID(),
      integrationId: "hyperliquid",
      mode: "live",
      assetKey,
      walletId: null,
      source: "certification",
      marketType,
      positionSide,
      amount: marketType === "spot" ? execution.receivedAmount : execution.executedAmount,
      amountFormat: "decimal",
      entryReference: execution.externalOrderId,
      assetSymbol: input.coin,
      entryPriceUsd: executionPriceUsd,
      currentPriceUsd: executionPriceUsd,
      entryCostUsd,
      feesUsd: feeUsd,
      leverage: plan.leverage,
      status: "open",
      openedAt: now,
      updatedAt: now,
    });
  } else {
    const costBasisUsd = consumedCost(lots, execution.executedAmount);
    const pnlUsd = hypercoreClosePnl(lots, Number(execution.executedAmount), executionPriceUsd, positionSide);
    const netProceedsUsd = Math.max(0, costBasisUsd + pnlUsd - feeUsd);
    store.reduceExecutionLots(lots, execution.executedAmount, { netProceedsUsd, feesUsd: feeUsd }, 10 ** -plan.sizeDecimals);
  }
  store.markExecutionAccounted(requestId);
  return `hyperliquid:${execution.externalOrderId}`;
}

function hypercoreClosePnl(
  lots: ReturnType<typeof store.getOpenExecutionLots>,
  quantity: number,
  closePriceUsd: number,
  side: "long" | "short",
) {
  let remaining = quantity;
  let pnlUsd = 0;
  for (const lot of lots) {
    if (remaining <= 0) break;
    const consumed = Math.min(Number(lot.amount), remaining);
    pnlUsd += (side === "short" ? -1 : 1) * (closePriceUsd - lot.entryPriceUsd) * consumed;
    remaining -= consumed;
  }
  return pnlUsd;
}
