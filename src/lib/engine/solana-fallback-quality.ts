export interface SolanaFallbackCandidateEvidence {
  candidateScore: number;
  estimatedPnlUsd: number;
  estimatedPnlPercent: number;
  swapCount24h: number;
  historySwapCount: number;
  historySellCount: number;
  completedRoundTrips: number;
}

export function calculateSolanaFallbackScore(evidence: SolanaFallbackCandidateEvidence) {
  if (evidence.completedRoundTrips > 0) return null;
  if (evidence.estimatedPnlUsd < 100) return null;
  if (evidence.estimatedPnlPercent < 5 || evidence.estimatedPnlPercent > 500) return null;
  if (evidence.swapCount24h < 2 || evidence.swapCount24h > 50) return null;

  const pnlStrength = Math.min(5, Math.log10(Math.max(1, evidence.estimatedPnlUsd / 100)) * 5);
  const roiStrength = Math.min(4, evidence.estimatedPnlPercent / 50);
  const historyBonus = Math.min(5, evidence.historySwapCount * 0.35 + evidence.historySellCount);
  return Math.min(72, Math.max(58, Math.round(58 + pnlStrength + roiStrength + historyBonus)));
}
