import type { DiscoveryScoreBreakdown } from "../domain/types.ts";
import { isDiscoveryReturnEligible } from "./discovery-pnl.ts";

export interface SolanaSmartWalletMetrics {
  trades24h: number;
  buys24h: number;
  invested24hUsd: number;
  invested7dUsd: number;
  uniqueTokens7d: number;
  closedTokens7d: number;
  winRate7d: number;
  realizedPnl7dUsd: number;
  realizedRoi7dPercent: number;
  unrealizedPnl7dUsd: number;
  totalPnl7dUsd: number;
  averageBuyUsd: number;
  suspiciousTagCount: number;
}

export function isSolanaSmartWalletEligible(metrics: SolanaSmartWalletMetrics) {
  return solanaSmartWalletRejectionReasons(metrics).length === 0;
}

export function solanaSmartWalletRejectionReasons(metrics: SolanaSmartWalletMetrics) {
  const reasons: string[] = [];
  if (metrics.trades24h < 2) reasons.push("low_activity");
  if (metrics.trades24h > 50) reasons.push("high_activity");
  if (metrics.buys24h <= 0 || metrics.invested24hUsd < 100) reasons.push("low_investment");
  if (metrics.averageBuyUsd < 100) reasons.push("small_ticket");
  if (metrics.averageBuyUsd > 20_000) reasons.push("large_ticket");
  reasons.push(...solanaSmartWalletHistoryRejectionReasons(metrics));
  return reasons;
}

export function solanaSmartWalletHistoryRejectionReasons(metrics: Pick<SolanaSmartWalletMetrics,
  "invested7dUsd" | "uniqueTokens7d" | "closedTokens7d" | "winRate7d" | "realizedPnl7dUsd" |
  "realizedRoi7dPercent" | "unrealizedPnl7dUsd" | "totalPnl7dUsd" | "suspiciousTagCount"
>) {
  const reasons: string[] = [];
  if (metrics.invested7dUsd > 250_000) reasons.push("whale_capital");
  if (metrics.closedTokens7d < 1) reasons.push("low_closed_sample");
  if (metrics.realizedPnl7dUsd <= 0) reasons.push("low_realized_pnl");
  if (metrics.totalPnl7dUsd < 100) reasons.push("low_total_pnl");
  if (!isDiscoveryReturnEligible(metrics.invested7dUsd, metrics.totalPnl7dUsd)) reasons.push("low_return_multiple");
  if (!Number.isFinite(metrics.realizedRoi7dPercent)
    || metrics.realizedRoi7dPercent <= 0
    || metrics.realizedRoi7dPercent > 1_000) reasons.push("invalid_roi");
  if (metrics.suspiciousTagCount > 0) reasons.push("suspicious_tags");
  return reasons;
}

export function calculateSolanaSmartWalletScore(metrics: SolanaSmartWalletMetrics) {
  const realizedScale = clamp(35 + Math.log10(Math.max(1, metrics.realizedPnl7dUsd)) * 18);
  const roiScale = clamp(45 + metrics.realizedRoi7dPercent * 0.8);
  const profitability = clamp(realizedScale * 0.65 + roiScale * 0.35);
  const consistency = clamp(metrics.winRate7d * 0.7 + Math.min(100, metrics.closedTokens7d * 10) * 0.3);
  const drawdownRatio = metrics.realizedPnl7dUsd > 0 ? Math.max(0, -metrics.unrealizedPnl7dUsd) / metrics.realizedPnl7dUsd : 1;
  const riskControl = clamp(100 - drawdownRatio * 100);
  const activity = metrics.trades24h <= 20
    ? clamp(45 + metrics.trades24h * 2.75)
    : clamp(100 - (metrics.trades24h - 20) * 2);
  const ticketDistance = Math.abs(Math.log10(Math.max(100, metrics.averageBuyUsd)) - Math.log10(1_500));
  const copyability = clamp(activity * 0.65 + clamp(100 - ticketDistance * 32) * 0.35);
  const freshness = 100;
  const safety = metrics.suspiciousTagCount ? 0 : 100;
  const score = clamp(
    profitability * 0.35
    + consistency * 0.2
    + riskControl * 0.15
    + copyability * 0.15
    + freshness * 0.1
    + safety * 0.05,
  );
  const breakdown: DiscoveryScoreBreakdown = {
    profitability,
    activity: copyability,
    diversity: consistency,
    balance: riskControl,
    freshness,
  };
  return { score, breakdown };
}

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
