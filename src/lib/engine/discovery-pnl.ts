export const MIN_DISCOVERY_BOUGHT_USD = 100;
export const MIN_DISCOVERY_PNL_USD = 100;
export const MIN_DISCOVERY_SWAPS = 2;
export const MAX_DISCOVERY_PNL_PERCENT = 500;

export function calculateMarkToMarketPnl(boughtUsd: number, soldUsd: number, currentValueUsd: number) {
  const estimatedPnlUsd = soldUsd + currentValueUsd - boughtUsd;
  const estimatedPnlPercent = boughtUsd > 0 ? (estimatedPnlUsd / boughtUsd) * 100 : 0;
  return { estimatedPnlUsd, estimatedPnlPercent };
}

export function isDiscoveryCandidateEligible(boughtUsd: number, estimatedPnlUsd: number) {
  return boughtUsd >= MIN_DISCOVERY_BOUGHT_USD && estimatedPnlUsd >= MIN_DISCOVERY_PNL_USD;
}

export function isDiscoveryTokenPerformanceEligible(input: {
  boughtUsd: number;
  estimatedPnlUsd: number;
  swapCount: number;
  buyCount: number;
  sellCount: number;
}) {
  const pnlPercent = input.boughtUsd > 0 ? input.estimatedPnlUsd / input.boughtUsd * 100 : 0;
  return input.swapCount >= MIN_DISCOVERY_SWAPS
    && input.buyCount > 0
    && input.sellCount > 0
    && pnlPercent <= MAX_DISCOVERY_PNL_PERCENT
    && isDiscoveryCandidateEligible(input.boughtUsd, input.estimatedPnlUsd);
}
