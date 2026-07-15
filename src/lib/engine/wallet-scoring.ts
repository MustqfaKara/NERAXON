import type { WalletScoreBreakdown } from "@/lib/domain/types";

export interface WalletMetrics {
  totalTrades: number;
  winRate: number;
  realizedPnlPercent: number;
  maxDrawdownPercent: number;
  averageHoldMinutes: number;
  lowLiquidityTradeRatio: number;
  copyableTradeRatio: number;
  suspiciousActivityRatio: number;
}

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

export function calculateWalletScore(metrics?: Partial<WalletMetrics>): {
  score: number;
  breakdown: WalletScoreBreakdown;
} {
  if (!metrics || !metrics.totalTrades) {
    return {
      score: 50,
      breakdown: {
        profitability: 50,
        consistency: 50,
        riskControl: 50,
        copyability: 50,
        safety: 50,
      },
    };
  }

  const breakdown: WalletScoreBreakdown = {
    profitability: clamp(50 + (metrics.realizedPnlPercent ?? 0) * 1.5),
    consistency: clamp((metrics.winRate ?? 0) * 100),
    riskControl: clamp(100 - (metrics.maxDrawdownPercent ?? 0) * 2.5),
    copyability: clamp((metrics.copyableTradeRatio ?? 0.5) * 100),
    safety: clamp(100 - (metrics.lowLiquidityTradeRatio ?? 0) * 50 - (metrics.suspiciousActivityRatio ?? 0) * 100),
  };

  const score = clamp(
    breakdown.profitability * 0.25 +
      breakdown.consistency * 0.2 +
      breakdown.riskControl * 0.2 +
      breakdown.copyability * 0.2 +
      breakdown.safety * 0.15,
  );
  return { score, breakdown };
}
