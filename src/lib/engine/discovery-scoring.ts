import type { DiscoveryScoreBreakdown } from "../domain/types.ts";

export interface DiscoveryMetrics {
  swapCount: number;
  buyCount: number;
  sellCount: number;
  uniqueTokenCount: number;
  ageMinutes: number;
  estimatedPnlPercent: number;
  boughtUsd?: number;
  estimatedPnlUsd?: number;
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
  const roiScore = clamp(20 + Math.min(200, Math.max(0, metrics.estimatedPnlPercent)) * 0.4);
  const pnlScore = clamp(20 + Math.log10(Math.max(1, metrics.estimatedPnlUsd ?? 1)) * 18);
  const capitalDistance = Math.abs(Math.log10(Math.max(100, metrics.boughtUsd ?? 3_000)) - Math.log10(3_000));
  const capitalFit = clamp(100 - capitalDistance * 35);
  const activityScore = metrics.swapCount <= 20
    ? clamp(30 + metrics.swapCount * 3.5)
    : clamp(100 - (metrics.swapCount - 20) * 1.2);
  const diversityScore = metrics.uniqueTokenCount <= 5
    ? clamp(30 + metrics.uniqueTokenCount * 14)
    : clamp(100 - (metrics.uniqueTokenCount - 5) * 10);
  const breakdown: DiscoveryScoreBreakdown = {
    profitability: clamp(roiScore * 0.45 + pnlScore * 0.35 + capitalFit * 0.2),
    activity: activityScore,
    diversity: diversityScore,
    balance: clamp(38 + directionalBalance * 62),
    freshness: clamp(100 - metrics.ageMinutes / 20),
  };
  const score = clamp(
    breakdown.profitability * 0.4 +
    breakdown.activity * 0.2 +
    breakdown.diversity * 0.15 +
    breakdown.balance * 0.1 +
    breakdown.freshness * 0.15,
  );
  return { score, breakdown };
}
