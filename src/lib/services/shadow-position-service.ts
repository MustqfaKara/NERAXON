import { formatEther, formatUnits, getAddress } from "viem";
import type { EvmChainId, ExecutionLot, HypercorePositionSide } from "@/lib/domain/types";
import { isEvmChain } from "@/lib/domain/defaults";
import { dexFeePercentFor } from "@/lib/engine/paper-execution-model";
import { getEvmExecutionAdapter } from "@/lib/execution/evm-execution-adapter";
import { hypercoreExecutionAdapter } from "@/lib/execution/hypercore-execution-adapter";
import { assertEvmExecutionRisk } from "@/lib/execution/live-execution-guard";
import { solanaExecutionAdapter } from "@/lib/execution/solana-execution-adapter";
import { store } from "@/lib/repositories/store";
import { applyShadowSell, assertShadowPortfolioRisk, consumedCost } from "@/lib/services/execution-accounting";
import { getMarketDataProvider } from "@/lib/services/market-data-provider";
import { SOLANA_LAMPORTS_PER_SOL, SOLANA_NATIVE_MINT } from "@/lib/solana/constants";
import { assertNetworkFeeLimit } from "@/lib/execution/network-fee-guard";
import { estimateSolanaRouteFeeUsd } from "@/lib/execution/solana-fee";
import { assertPriceDeviation, prepareFreshQuote } from "@/lib/execution/execution-quote-guard";
import { publishEmergencyExitDeviation } from "@/lib/services/emergency-exit-notification";

export interface ShadowCloseResult {
  requestId: string;
  integrationId: ExecutionLot["integrationId"];
  assetKey: string;
  closedAmount: string;
  netProceedsUsd: number;
  realizedPnlUsd: number;
  costsUsd: number;
}

export async function closeShadowExecutionLots(inputLots: ExecutionLot[], reason: "close-all" | "source-reconciliation") {
  const lots = inputLots.filter((lot) => lot.mode === "shadow" && lot.status === "open");
  if (!lots.length) throw new Error("Kapatılabilecek açık shadow lotu bulunamadı.");
  assertSamePosition(lots);
  if (lots[0].integrationId === "hyperliquid") return closeHypercoreLots(lots, reason);
  if (lots[0].integrationId === "solana") return closeSolanaLots(lots, reason);
  if (isEvmChain(lots[0].integrationId)) return closeEvmLots(lots, reason);
  throw new Error(`${lots[0].integrationId} shadow kapatma adaptörü bulunamadı.`);
}

export function groupOpenShadowLots(lots = store.listExecutionLots("shadow")) {
  const groups = new Map<string, ExecutionLot[]>();
  for (const lot of lots.filter((item) => item.status === "open")) {
    const key = [lot.integrationId, lot.assetKey.toLowerCase(), lot.positionSide ?? "spot"].join(":");
    groups.set(key, [...(groups.get(key) ?? []), lot]);
  }
  return [...groups.values()];
}

async function closeEvmLots(lots: ExecutionLot[], reason: string): Promise<ShadowCloseResult> {
  const lot = lots[0];
  const chainId = lot.integrationId as EvmChainId;
  const requestId = createAttempt(lot, reason);
  try {
    const exactSellAmount = lots.reduce((sum, item) => sum + BigInt(item.amount), 0n);
    const settings = store.getRiskSettings();
    const market = await getMarketDataProvider().getTokenMarket(chainId, lot.assetKey);
    const adapter = getEvmExecutionAdapter(chainId);
    const intent = {
      chainId,
      side: "sell",
      tokenAddress: getAddress(lot.assetKey),
      exactSellAmount,
      slippagePercent: Math.min(0.5, settings.maxSlippagePercent),
      mode: "shadow",
    } as const;
    const prepared = await prepareFreshQuote({ chainId, settings, prepare: () => adapter.prepare(intent), quotedAt: (current) => current.quotedAt });
    const plan = prepared.plan;
    const risk = await assertEvmExecutionRisk({ chainId, plan, settings });
    const quotedTokenQuantity = Number(formatUnits(plan.sellAmount, lot.assetDecimals));
    const quoteGuard = assertPriceDeviation({ chainId, side: "sell", referencePriceUsd: market.priceUsd, quotedPriceUsd: quotedTokenQuantity > 0 ? risk.estimatedTradeUsd / quotedTokenQuantity : 0, quotedAt: plan.quotedAt, quoteRefreshed: prepared.quoteRefreshed, emergencyExit: true, settings });
    const dexFeeUsd = risk.estimatedTradeUsd * dexFeePercentFor(market.dexId) / 100;
    assertNetworkFeeLimit({ chainId, tradeUsd: risk.estimatedTradeUsd, networkFeeUsd: risk.gasFeeUsd, venueFeeUsd: dexFeeUsd, emergencyExit: true, settings });
    await assertShadowPortfolioRisk({ chainId, assetKey: lot.assetKey, walletId: null, side: "sell", estimatedTradeUsd: risk.estimatedTradeUsd });
    const startedAt = performance.now();
    const execution = await adapter.simulate(plan);
    const amountIn = BigInt(execution.executedAmount);
    const amountOut = BigInt(execution.receivedAmount);
    const grossProceedsUsd = Number(formatEther(amountOut)) * risk.nativePriceUsd;
    const costsUsd = risk.gasFeeUsd + dexFeeUsd;
    const netProceedsUsd = Math.max(0, grossProceedsUsd - risk.gasFeeUsd);
    const costBasisUsd = consumedCost(lots, amountIn.toString());
    const tokenQuantity = Number(formatUnits(amountIn, lot.assetDecimals));
    store.updateExecutionAttempt(requestId, {
      status: "simulated",
      amountIn,
      amountOut,
      expectedAmountOut: plan.buyAmount.toString(),
      minimumAmountOut: plan.minBuyAmount.toString(),
      quotedPriceUsd: tokenQuantity > 0 ? grossProceedsUsd / tokenQuantity : lot.currentPriceUsd,
      slippagePercent: Math.min(0.5, settings.maxSlippagePercent),
      priceImpactPercent: market.priceUsd > 0 && tokenQuantity > 0 ? Math.abs(grossProceedsUsd / tokenQuantity / market.priceUsd - 1) * 100 : 0,
      networkFeeUsd: risk.gasFeeUsd,
      dexFeeUsd,
      availableBalanceUsd: store.getShadowAccount(chainId)?.cashBalanceUsd ?? 0,
      simulationLatencyMs: Math.round(performance.now() - startedAt),
      metadata: { ...quoteGuard, reason, target: plan.transaction.to },
    });
    store.reduceExecutionLots(lots, amountIn.toString(), { netProceedsUsd, feesUsd: costsUsd });
    applyShadowSell(chainId, netProceedsUsd, netProceedsUsd - costBasisUsd, costsUsd);
    await publishEmergencyExitDeviation({ chainId, asset: lot.assetSymbol || lot.assetKey, assessment: quoteGuard, settings, txHash: execution.txHash });
    return result(requestId, lot, amountIn.toString(), netProceedsUsd, costBasisUsd, costsUsd);
  } catch (error) {
    failAttempt(requestId, error);
    throw error;
  }
}

async function closeSolanaLots(lots: ExecutionLot[], reason: string): Promise<ShadowCloseResult> {
  const lot = lots[0];
  const requestId = createAttempt(lot, reason);
  try {
    const exactSellAmount = lots.reduce((sum, item) => sum + BigInt(item.amount), 0n);
    const settings = store.getRiskSettings();
    const nativeMarket = await getMarketDataProvider().getTokenMarket("solana", SOLANA_NATIVE_MINT);
    const intent = {
      side: "sell",
      tokenAddress: lot.assetKey,
      exactSellAmount,
      slippagePercent: Math.min(0.5, settings.maxSlippagePercent),
      mode: "shadow",
    } as const;
    const prepared = await prepareFreshQuote({ chainId: "solana", settings, prepare: () => solanaExecutionAdapter.prepare(intent), quotedAt: (current) => current.quotedAt });
    const plan = prepared.plan;
    const grossProceedsUsd = Number(plan.quote.outAmount) / SOLANA_LAMPORTS_PER_SOL * nativeMarket.priceUsd;
    const quotedTokenQuantity = Number(formatUnits(BigInt(plan.quote.inAmount), lot.assetDecimals));
    const quoteGuard = assertPriceDeviation({ chainId: "solana", side: "sell", referencePriceUsd: lot.currentPriceUsd, quotedPriceUsd: quotedTokenQuantity > 0 ? grossProceedsUsd / quotedTokenQuantity : 0, quotedAt: plan.quotedAt, quoteRefreshed: prepared.quoteRefreshed, emergencyExit: true, settings });
    const networkFeeUsd = plan.estimatedPriorityFeeLamports / SOLANA_LAMPORTS_PER_SOL * nativeMarket.priceUsd;
    const dexFeeUsd = estimateSolanaRouteFeeUsd(plan.quote, nativeMarket.priceUsd, lot.currentPriceUsd, lot.assetDecimals);
    assertNetworkFeeLimit({ chainId: "solana", tradeUsd: grossProceedsUsd, networkFeeUsd, venueFeeUsd: dexFeeUsd, emergencyExit: true, settings });
    await assertShadowPortfolioRisk({ chainId: "solana", assetKey: lot.assetKey, walletId: null, side: "sell", estimatedTradeUsd: grossProceedsUsd });
    const startedAt = performance.now();
    const execution = await solanaExecutionAdapter.simulate(plan);
    const amountIn = BigInt(execution.executedAmount);
    const amountOut = BigInt(execution.receivedAmount);
    const netProceedsUsd = Math.max(0, Number(amountOut) / SOLANA_LAMPORTS_PER_SOL * nativeMarket.priceUsd - networkFeeUsd);
    const costBasisUsd = consumedCost(lots, amountIn.toString());
    const tokenQuantity = Number(formatUnits(amountIn, lot.assetDecimals));
    store.updateExecutionAttempt(requestId, {
      status: "simulated",
      amountIn,
      amountOut,
      expectedAmountOut: plan.quote.outAmount,
      minimumAmountOut: plan.quote.otherAmountThreshold,
      quotedPriceUsd: tokenQuantity > 0 ? grossProceedsUsd / tokenQuantity : lot.currentPriceUsd,
      slippagePercent: plan.quote.slippageBps / 100,
      priceImpactPercent: Number(plan.quote.priceImpactPct) * 100,
      networkFeeUsd,
      dexFeeUsd,
      availableBalanceUsd: store.getShadowAccount("solana")?.cashBalanceUsd ?? 0,
      simulationLatencyMs: Math.round(performance.now() - startedAt),
      metadata: { ...quoteGuard, reason, contextSlot: plan.quote.contextSlot, computeUnitLimit: plan.transaction.computeUnitLimit, shadowSimulation: plan.shadowSimulation },
    });
    const costsUsd = networkFeeUsd + dexFeeUsd;
    store.reduceExecutionLots(lots, amountIn.toString(), { netProceedsUsd, feesUsd: costsUsd });
    applyShadowSell("solana", netProceedsUsd, netProceedsUsd - costBasisUsd, costsUsd);
    await publishEmergencyExitDeviation({ chainId: "solana", asset: lot.assetSymbol || lot.assetKey, assessment: quoteGuard, settings, txHash: execution.txHash });
    return result(requestId, lot, amountIn.toString(), netProceedsUsd, costBasisUsd, costsUsd);
  } catch (error) {
    failAttempt(requestId, error);
    throw error;
  }
}

async function closeHypercoreLots(lots: ExecutionLot[], reason: string): Promise<ShadowCloseResult> {
  const lot = lots[0];
  const requestId = createAttempt(lot, reason);
  try {
    const exactCloseQuantity = lots.reduce((sum, item) => sum + Number(item.amount), 0);
    const settings = store.getRiskSettings();
    const intent = {
      coin: lot.assetSymbol || lot.assetKey.split(":").at(-1)!,
      marketType: lot.marketType === "perp" ? "perp" : "spot",
      positionSide: lot.positionSide ?? "long",
      action: "close",
      exactCloseQuantity,
      leverage: lot.leverage,
      slippagePercent: Math.min(0.5, settings.maxSlippagePercent),
      mode: "shadow",
    } as const;
    const prepared = await prepareFreshQuote({ chainId: "hyperliquid", settings, prepare: () => hypercoreExecutionAdapter.prepare(intent), quotedAt: (current) => current.quotedAt });
    const plan = prepared.plan;
    const quoteGuard = assertPriceDeviation({ chainId: "hyperliquid", side: "sell", referencePriceUsd: plan.referencePriceUsd, quotedPriceUsd: Number(plan.limitPrice), quotedAt: plan.quotedAt, quoteRefreshed: prepared.quoteRefreshed, emergencyExit: true, settings });
    const feeUsd = plan.notionalUsd * 0.00035;
    assertNetworkFeeLimit({ chainId: "hyperliquid", tradeUsd: plan.notionalUsd, venueFeeUsd: feeUsd, settings });
    await assertShadowPortfolioRisk({ chainId: "hyperliquid", assetKey: lot.assetKey, walletId: null, side: "sell", estimatedTradeUsd: plan.notionalUsd });
    const startedAt = performance.now();
    const execution = await hypercoreExecutionAdapter.simulate(plan);
    const executedQuantity = Number(execution.executedAmount);
    const costBasisUsd = consumedCost(lots, execution.executedAmount);
    const pnlUsd = hypercoreClosePnl(lots, executedQuantity, Number(plan.limitPrice), lot.positionSide ?? "long");
    const netProceedsUsd = Math.max(0, costBasisUsd + pnlUsd - feeUsd);
    store.updateExecutionAttempt(requestId, {
      status: "simulated",
      amountIn: execution.executedAmount,
      amountOut: execution.receivedAmount,
      expectedAmountOut: plan.size,
      minimumAmountOut: plan.size,
      quotedPriceUsd: Number(plan.limitPrice),
      slippagePercent: Math.min(0.5, settings.maxSlippagePercent),
      priceImpactPercent: lot.currentPriceUsd > 0 ? Math.abs(Number(plan.limitPrice) / lot.currentPriceUsd - 1) * 100 : 0,
      networkFeeUsd: 0,
      dexFeeUsd: feeUsd,
      availableBalanceUsd: store.getShadowAccount("hyperliquid")?.cashBalanceUsd ?? 0,
      simulationLatencyMs: Math.round(performance.now() - startedAt),
      metadata: { ...quoteGuard, reason, assetId: plan.assetId, reduceOnly: plan.reduceOnly, leverage: plan.leverage, marketType: plan.marketType },
    });
    store.reduceExecutionLots(lots, execution.executedAmount, { netProceedsUsd, feesUsd: feeUsd });
    applyShadowSell("hyperliquid", netProceedsUsd, netProceedsUsd - costBasisUsd, feeUsd);
    await publishEmergencyExitDeviation({ chainId: "hyperliquid", asset: lot.assetSymbol || lot.assetKey, assessment: quoteGuard, settings });
    return result(requestId, lot, execution.executedAmount, netProceedsUsd, costBasisUsd, feeUsd);
  } catch (error) {
    failAttempt(requestId, error);
    throw error;
  }
}

function createAttempt(lot: ExecutionLot, reason: string) {
  const requestId = `shadow:${reason}:${lot.integrationId}:${crypto.randomUUID()}`;
  store.insertExecutionAttempt({ requestId, integrationId: lot.integrationId, mode: "shadow", source: "manual", action: "close", asset: lot.assetSymbol || lot.assetKey });
  return requestId;
}

function failAttempt(requestId: string, error: unknown) {
  store.updateExecutionAttempt(requestId, { status: "failed", errorMessage: error instanceof Error ? error.message : "Shadow pozisyon kapatılamadı." });
}

function assertSamePosition(lots: ExecutionLot[]) {
  const first = lots[0];
  const mismatch = lots.some((lot) => lot.integrationId !== first.integrationId
    || lot.assetKey.toLowerCase() !== first.assetKey.toLowerCase()
    || lot.positionSide !== first.positionSide
    || lot.amountFormat !== first.amountFormat);
  if (mismatch) throw new Error("Farklı shadow pozisyon lotları tek emirle kapatılamaz.");
}

function hypercoreClosePnl(lots: ExecutionLot[], quantity: number, closePriceUsd: number, side: HypercorePositionSide) {
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

function result(requestId: string, lot: ExecutionLot, closedAmount: string, netProceedsUsd: number, costBasisUsd: number, costsUsd: number): ShadowCloseResult {
  return {
    requestId,
    integrationId: lot.integrationId,
    assetKey: lot.assetKey,
    closedAmount,
    netProceedsUsd,
    realizedPnlUsd: netProceedsUsd - costBasisUsd,
    costsUsd,
  };
}
