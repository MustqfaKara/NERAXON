export function calculateShadowPnl(input: {
  startingEquityUsd: number;
  equityUsd: number;
  realizedPnlUsd: number;
  positionValueUsd: number;
  remainingPositionCostUsd: number;
}) {
  const positionUnrealizedPnlUsd = input.positionValueUsd - input.remainingPositionCostUsd;
  const unrealizedPnlUsd = input.equityUsd - input.startingEquityUsd - input.realizedPnlUsd;
  const fundingTokenPnlUsd = unrealizedPnlUsd - positionUnrealizedPnlUsd;
  return { unrealizedPnlUsd, positionUnrealizedPnlUsd, fundingTokenPnlUsd };
}
