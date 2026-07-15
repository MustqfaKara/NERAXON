import type { Trade } from "../domain/types.ts";

export interface AnalyticsTrade extends Trade {
  derivedRealizedPnlUsd: number;
  hasRealizedOutcome: boolean;
}

interface CostLot {
  walletId: string | null;
  remainingQuantity: number;
  remainingCostUsd: number;
}

export function deriveTradeOutcomes(trades: Trade[]): AnalyticsTrade[] {
  const chronological = [...trades].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const lotsByToken = new Map<string, CostLot[]>();
  return chronological.map((trade) => {
    const tokenKey = `${trade.chainId}:${trade.tokenAddress.toLowerCase()}`;
    const lots = lotsByToken.get(tokenKey) ?? [];
    if (trade.side === "buy" && trade.quantity > 0) {
      lots.push({ walletId: trade.walletId, remainingQuantity: trade.quantity, remainingCostUsd: trade.netUsd });
      lotsByToken.set(tokenKey, lots);
      return { ...trade, derivedRealizedPnlUsd: 0, hasRealizedOutcome: false };
    }
    if (trade.side !== "sell" || trade.quantity <= 0) {
      return { ...trade, derivedRealizedPnlUsd: 0, hasRealizedOutcome: false };
    }

    let remainingToSell = trade.quantity;
    let consumedQuantity = 0;
    let consumedCostUsd = 0;
    for (const lot of lots) {
      const eligible = trade.source === "manual" || lot.walletId === trade.walletId;
      if (!eligible || remainingToSell <= 1e-12 || lot.remainingQuantity <= 1e-12) continue;
      const quantity = Math.min(remainingToSell, lot.remainingQuantity);
      const cost = lot.remainingCostUsd * (quantity / lot.remainingQuantity);
      lot.remainingQuantity -= quantity;
      lot.remainingCostUsd -= cost;
      remainingToSell -= quantity;
      consumedQuantity += quantity;
      consumedCostUsd += cost;
    }
    const matchedProceedsUsd = trade.netUsd * (consumedQuantity / trade.quantity);
    return {
      ...trade,
      derivedRealizedPnlUsd: consumedQuantity > 1e-12 ? matchedProceedsUsd - consumedCostUsd : 0,
      hasRealizedOutcome: consumedQuantity > 1e-12,
    };
  });
}
