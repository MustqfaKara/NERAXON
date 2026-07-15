import type { FeeBreakdown, ManualTradeInput, PositionLot, Trade } from "@/lib/domain/types";
import { evaluateBuy } from "@/lib/engine/risk-engine";
import { calculateSellQuantity } from "@/lib/engine/position-sizing";
import { modelPaperExecution } from "@/lib/engine/paper-execution-model";
import { getDashboardSnapshot } from "@/lib/services/dashboard-service";
import { publishEvent } from "@/lib/services/audit-service";
import { store } from "@/lib/repositories/store";
import { estimatePaperGas } from "@/lib/services/gas-estimator";

export interface PaperTradeContext {
  source: "copy" | "manual";
  walletId: string | null;
  walletScore: number;
  sourceLabel?: string;
  txHash?: string;
  allowConsensusBuy?: boolean;
}

const MANUAL_CONTEXT: PaperTradeContext = {
  source: "manual",
  walletId: null,
  walletScore: 70,
};

export async function executePaperTrade(input: ManualTradeInput, context: PaperTradeContext = MANUAL_CONTEXT): Promise<Trade> {
  if (store.getMode() !== "paper") throw new Error("Paper motoru yalnızca paper modda kullanılabilir.");
  if (input.priceUsd <= 0) throw new Error("Token fiyatı sıfırdan büyük olmalı.");

  return input.side === "buy" ? executeBuy(input, context) : executeSell(input, context);
}

async function executeBuy(input: ManualTradeInput, context: PaperTradeContext): Promise<Trade> {
  const existing = store.getPosition(input.chainId, input.tokenAddress);
  const snapshot = getDashboardSnapshot();
  const liquidityUsd = input.liquidityUsd ?? 250_000;
  const slippagePercent = input.slippagePercent ?? 0.5;
  const requestedAllocation = input.allocationPercent;
  const effectiveScore = requestedAllocation && context.source === "manual"
    ? 45 + ((requestedAllocation - snapshot.riskSettings.minPositionPercent) /
        (snapshot.riskSettings.maxPositionPercent - snapshot.riskSettings.minPositionPercent)) * 40
    : context.walletScore;
  const estimatedAllocationUsd = (snapshot.equityUsd * (requestedAllocation ?? 7.5)) / 100;
  const priceImpactPercent = Math.min(20, (estimatedAllocationUsd / liquidityUsd) * 100);
  const decision = evaluateBuy(snapshot.riskSettings, {
    equityUsd: snapshot.equityUsd,
    cashBalanceUsd: snapshot.cashBalanceUsd,
    openPositions: snapshot.positions,
    walletScore: effectiveScore,
    liquidityUsd,
    slippagePercent,
    priceImpactPercent,
    dailyPnlUsd: snapshot.dailyPnlUsd,
    tokenExposureUsd: existing?.investedUsd ?? 0,
    walletExposureUsd: context.walletId ? store.listPositionLots(undefined, undefined, context.walletId).reduce((sum, lot) => sum + lot.entryCostUsd * lot.remainingQuantity / lot.initialQuantity, 0) : 0,
    isExistingTokenPosition: Boolean(existing),
    priceChange24hPercent: input.priceChange24hPercent,
    circuitBreakerHalted: snapshot.circuitBreaker.halted,
  });

  if (!decision.approved) return recordSkippedTrade(input, decision.reason, context);

  const grossUsd = decision.allocationUsd;
  const gasFeeUsd = input.gasFeeUsd ?? (await estimatePaperGas(input.chainId)).feeUsd;
  const executionDelayMs = input.executionDelayMs ?? (input.chainId === "base" ? 1_800 : 12_000);
  const execution = modelPaperExecution({
    side: "buy",
    quotedPriceUsd: input.priceUsd,
    grossUsd,
    liquidityUsd,
    slippagePercent,
    dexFeePercent: input.dexFeePercent ?? 0.3,
    tokenTaxPercent: input.buyTaxPercent ?? 0,
    priceChange24hPercent: input.priceChange24hPercent ?? 0,
    executionDelayMs,
    gasFeeUsd,
  });
  const fees = execution.fees;
  if (grossUsd + fees.gasFeeUsd > snapshot.cashBalanceUsd) {
    return recordSkippedTrade(input, "Gas dahil toplam maliyet kullanılabilir bakiyeyi aşıyor.", context);
  }
  const effectiveTokenUsd = grossUsd - fees.dexFeeUsd - fees.slippageUsd - fees.priceImpactUsd - fees.tokenTaxUsd;
  const quantity = effectiveTokenUsd / execution.fillPriceUsd;
  const now = new Date().toISOString();
  store.setCashBalance(snapshot.cashBalanceUsd - grossUsd - fees.gasFeeUsd);

  const trade = createTrade({ ...input, priceUsd: execution.fillPriceUsd }, quantity, grossUsd, grossUsd + fees.gasFeeUsd, 0, executionDelayMs, fees, "confirmed", decision.reason, context);
  store.insertTrade(trade);
  store.insertPositionLot({
    id: crypto.randomUUID(),
    chainId: input.chainId,
    tokenAddress: input.tokenAddress.toLowerCase(),
    tokenSymbol: input.tokenSymbol.toUpperCase(),
    pairAddress: input.pairAddress ?? null,
    walletId: context.source === "copy" ? context.walletId : null,
    walletLabel: context.source === "copy" ? context.sourceLabel ?? null : null,
    source: context.source,
    openedTradeId: trade.id,
    initialQuantity: quantity,
    remainingQuantity: quantity,
    entryPriceUsd: execution.fillPriceUsd,
    entryCostUsd: grossUsd + fees.gasFeeUsd,
    realizedPnlUsd: 0,
    openedAt: now,
    updatedAt: now,
  });
  store.syncPositionFromLots(input.chainId, input.tokenAddress, execution.fillPriceUsd, { tokenSymbol: input.tokenSymbol.toUpperCase(), pairAddress: input.pairAddress });
  await publishEvent({
    chainId: input.chainId,
    level: "info",
    type: "swap",
    title: `${input.tokenSymbol} paper alımı tamamlandı`,
    message: `${context.sourceLabel ? `${context.sourceLabel} kaynaklı ` : ""}${quantity.toFixed(6)} ${input.tokenSymbol} alındı. Toplam simüle maliyet ${trade.netUsd.toFixed(2)} USD.`,
    txHash: context.txHash ?? null,
  });
  return trade;
}

async function executeSell(input: ManualTradeInput, context: PaperTradeContext): Promise<Trade> {
  const snapshot = getDashboardSnapshot();
  const position = store.getPosition(input.chainId, input.tokenAddress);
  if (!position) return recordSkippedTrade(input, "Satılabilecek açık pozisyon bulunamadı.", context);
  const eligibleLots = context.source === "copy" && context.walletId
    ? store.listPositionLots(input.chainId, input.tokenAddress, context.walletId)
    : store.listPositionLots(input.chainId, input.tokenAddress);
  if (!eligibleLots.length) {
    return recordSkippedTrade(input, `${input.tokenSymbol} için bu cüzdana bağlı açık lot bulunmadığından satış uygulanmadı.`, context);
  }
  const eligibleQuantity = eligibleLots.reduce((sum, lot) => sum + lot.remainingQuantity, 0);
  const quantity = calculateSellQuantity(eligibleQuantity, input.sellPercent, input.quantity);
  const quotedGrossUsd = quantity * input.priceUsd;
  const slippagePercent = input.slippagePercent ?? 0.5;
  const liquidityUsd = input.liquidityUsd ?? 250_000;
  const gasFeeUsd = input.gasFeeUsd ?? (await estimatePaperGas(input.chainId)).feeUsd;
  const executionDelayMs = input.executionDelayMs ?? (input.chainId === "base" ? 1_800 : 12_000);
  const execution = modelPaperExecution({
    side: "sell",
    quotedPriceUsd: input.priceUsd,
    grossUsd: quotedGrossUsd,
    liquidityUsd,
    slippagePercent,
    dexFeePercent: input.dexFeePercent ?? 0.3,
    tokenTaxPercent: input.sellTaxPercent ?? 0,
    priceChange24hPercent: input.priceChange24hPercent ?? 0,
    executionDelayMs,
    gasFeeUsd,
  });
  const grossUsd = quantity * execution.fillPriceUsd;
  const fees = execution.fees;
  const netUsd = Math.max(0, grossUsd - fees.totalUsd);
  const realizedPnlUsd = consumeLots(eligibleLots, quantity, netUsd);
  store.syncPositionFromLots(input.chainId, input.tokenAddress, execution.fillPriceUsd, { tokenSymbol: input.tokenSymbol.toUpperCase(), pairAddress: input.pairAddress });
  store.setCashBalance(snapshot.cashBalanceUsd + netUsd);

  const reason = context.source === "copy"
    ? "Takip edilen cüzdanın satışı paper pozisyonuna uygulandı."
    : `Açık paper pozisyonunun %${input.sellPercent ?? 100} oranındaki kısmı manuel olarak satıldı.`;
  const trade = createTrade({ ...input, priceUsd: execution.fillPriceUsd }, quantity, grossUsd, netUsd, realizedPnlUsd, executionDelayMs, fees, "confirmed", reason, context);
  store.insertTrade(trade);
  await publishEvent({
    chainId: input.chainId,
    level: "info",
    type: "swap",
    title: `${input.tokenSymbol} paper satışı tamamlandı`,
    message: `${quantity.toFixed(6)} ${input.tokenSymbol} satıldı. Ücretler sonrası ${netUsd.toFixed(2)} USD bakiyeye geçti.`,
    txHash: context.txHash ?? null,
  });
  return trade;
}

function createTrade(
  input: ManualTradeInput,
  quantity: number,
  grossUsd: number,
  netUsd: number,
  realizedPnlUsd: number,
  executionDelayMs: number,
  fees: FeeBreakdown,
  status: Trade["status"],
  reason: string,
  context: PaperTradeContext,
): Trade {
  return {
    id: crypto.randomUUID(),
    chainId: input.chainId,
    walletId: context.walletId,
    source: context.source,
    side: input.side,
    tokenAddress: input.tokenAddress.toLowerCase(),
    tokenSymbol: input.tokenSymbol.toUpperCase(),
    quantity,
    priceUsd: input.priceUsd,
    grossUsd,
    netUsd,
    realizedPnlUsd,
    executionDelayMs,
    status,
    fees,
    reason,
    txHash: context.txHash ?? null,
    createdAt: new Date().toISOString(),
  };
}

export async function recordSkippedPaperTrade(input: ManualTradeInput, reason: string, context: PaperTradeContext): Promise<Trade> {
  const emptyFees: FeeBreakdown = { dexFeeUsd: 0, gasFeeUsd: 0, slippageUsd: 0, priceImpactUsd: 0, tokenTaxUsd: 0, totalUsd: 0 };
  const trade = createTrade(input, 0, 0, 0, 0, 0, emptyFees, "skipped", reason, context);
  store.insertTrade(trade);
  await publishEvent({
    chainId: input.chainId,
    level: "warning",
    type: "swap",
    title: `${input.tokenSymbol.toUpperCase()} işlemi reddedildi`,
    message: reason,
    txHash: context.txHash ?? null,
  });
  return trade;
}

const recordSkippedTrade = recordSkippedPaperTrade;

function consumeLots(lots: PositionLot[], quantity: number, netProceedsUsd: number) {
  let remaining = quantity;
  let costBasisUsd = 0;
  const now = new Date().toISOString();
  for (const lot of lots) {
    if (remaining <= 0.000000001) break;
    const consumed = Math.min(lot.remainingQuantity, remaining);
    const lotCost = lot.entryCostUsd * (consumed / lot.initialQuantity);
    const lotProceeds = netProceedsUsd * (consumed / quantity);
    costBasisUsd += lotCost;
    store.updatePositionLot({
      ...lot,
      remainingQuantity: Math.max(0, lot.remainingQuantity - consumed),
      realizedPnlUsd: lot.realizedPnlUsd + lotProceeds - lotCost,
      updatedAt: now,
    });
    remaining -= consumed;
  }
  return netProceedsUsd - costBasisUsd;
}
