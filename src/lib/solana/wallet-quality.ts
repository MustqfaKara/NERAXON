import { SOLANA_QUOTE_MINTS } from "./constants.ts";
import type { HeliusEnhancedTransaction } from "./helius-client.ts";
import { extractSolanaSwapMovement } from "./swap-movement.ts";

interface TokenInventory {
  quantity: number;
  costUsd: number;
}

export interface SolanaWalletQualityStats {
  swapCount: number;
  buyCount: number;
  sellCount: number;
  uniqueTokenCount: number;
  completedRoundTrips: number;
  profitableRoundTrips: number;
  winRatePercent: number;
  realizedPnlUsd: number;
  realizedCostUsd: number;
  realizedPnlPercent: number;
}

export function calculateSolanaQualityEvidenceScore(stats: SolanaWalletQualityStats) {
  if (!stats.completedRoundTrips) return 0;
  const profitability = clamp(50 + stats.realizedPnlPercent * 1.2);
  const winRate = clamp(stats.winRatePercent);
  const repeatability = clamp(stats.completedRoundTrips * 12);
  const diversity = stats.uniqueTokenCount <= 12
    ? clamp(35 + stats.uniqueTokenCount * 7)
    : clamp(100 - (stats.uniqueTokenCount - 12) * 3);
  const activity = stats.swapCount <= 70
    ? clamp(45 + stats.swapCount * 1.1)
    : clamp(100 - (stats.swapCount - 70) * 0.9);
  return clamp(
    profitability * 0.3
    + winRate * 0.25
    + repeatability * 0.2
    + diversity * 0.15
    + activity * 0.1,
  );
}

export function analyzeSolanaWalletHistory(
  transactions: HeliusEnhancedTransaction[],
  walletAddress: string,
  solPriceUsd: number,
): SolanaWalletQualityStats {
  const inventories = new Map<string, TokenInventory>();
  const uniqueTokens = new Set<string>();
  let buyCount = 0;
  let sellCount = 0;
  let completedRoundTrips = 0;
  let profitableRoundTrips = 0;
  let realizedPnlUsd = 0;
  let realizedCostUsd = 0;

  const ordered = [...transactions]
    .filter((transaction) => transaction.feePayer === walletAddress)
    .sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0));

  for (const transaction of ordered) {
    const tokenMints = [...new Set((transaction.tokenTransfers ?? [])
      .filter((transfer) => transfer.mint && !SOLANA_QUOTE_MINTS.has(transfer.mint))
      .filter((transfer) => transfer.fromUserAccount === walletAddress || transfer.toUserAccount === walletAddress)
      .map((transfer) => transfer.mint!))];
    const movement = tokenMints
      .map((mint) => ({ mint, movement: extractSolanaSwapMovement(transaction, mint, solPriceUsd) }))
      .filter((item) => item.movement && item.movement.notionalUsd > 0)
      .sort((left, right) => right.movement!.notionalUsd - left.movement!.notionalUsd)[0];
    if (!movement?.movement) continue;

    const { direction, tokenAmount, notionalUsd } = movement.movement;
    const inventory = inventories.get(movement.mint) ?? { quantity: 0, costUsd: 0 };
    const feeUsd = Math.max(0, Number(transaction.fee ?? 0)) / 1_000_000_000 * solPriceUsd;
    uniqueTokens.add(movement.mint);

    if (direction === "buy") {
      inventory.quantity += tokenAmount;
      inventory.costUsd += notionalUsd + feeUsd;
      buyCount += 1;
    } else {
      sellCount += 1;
      const matchedQuantity = Math.min(tokenAmount, inventory.quantity);
      if (matchedQuantity > 0 && inventory.quantity > 0) {
        const matchedRatio = matchedQuantity / inventory.quantity;
        const matchedCostUsd = inventory.costUsd * matchedRatio;
        const matchedProceedsUsd = notionalUsd * (matchedQuantity / tokenAmount) - feeUsd;
        const pnlUsd = matchedProceedsUsd - matchedCostUsd;
        realizedCostUsd += matchedCostUsd;
        realizedPnlUsd += pnlUsd;
        completedRoundTrips += 1;
        if (pnlUsd > 0) profitableRoundTrips += 1;
        inventory.quantity -= matchedQuantity;
        inventory.costUsd -= matchedCostUsd;
      }
    }
    inventories.set(movement.mint, inventory);
  }

  return {
    swapCount: buyCount + sellCount,
    buyCount,
    sellCount,
    uniqueTokenCount: uniqueTokens.size,
    completedRoundTrips,
    profitableRoundTrips,
    winRatePercent: completedRoundTrips ? profitableRoundTrips / completedRoundTrips * 100 : 0,
    realizedPnlUsd,
    realizedCostUsd,
    realizedPnlPercent: realizedCostUsd > 0 ? realizedPnlUsd / realizedCostUsd * 100 : 0,
  };
}

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
