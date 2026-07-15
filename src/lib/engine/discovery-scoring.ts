import type { DiscoveryScoreBreakdown } from "../domain/types.ts";

export interface DiscoveryMetrics {
  swapCount: number;
  buyCount: number;
  sellCount: number;
  uniqueTokenCount: number;
  ageMinutes: number;
  estimatedPnlPercent: number;
}

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

export function calculateDiscoveryScore(metrics: DiscoveryMetrics): {
  score: number;
  breakdown: DiscoveryScoreBreakdown;
} {
  const directionalTotal = metrics.buyCount + metrics.sellCount;
  const directionalBalance = directionalTotal
    ? 1 - Math.abs(metrics.buyCount - metrics.sellCount) / directionalTotal
    : 0.35;
  const breakdown: DiscoveryScoreBreakdown = {
    profitability: clamp(45 + metrics.estimatedPnlPercent * 2),
    activity: clamp(28 + metrics.swapCount * 14),
    diversity: clamp(24 + metrics.uniqueTokenCount * 19),
    balance: clamp(38 + directionalBalance * 62),
    freshness: clamp(100 - metrics.ageMinutes / 18),
  };
  const score = clamp(
    breakdown.profitability * 0.3 +
    breakdown.activity * 0.25 +
    breakdown.diversity * 0.2 +
    breakdown.balance * 0.1 +
    breakdown.freshness * 0.15,
  );
  return { score, breakdown };
}
