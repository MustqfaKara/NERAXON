export const MIN_DISCOVERY_BOUGHT_USD = 100;
export const MIN_DISCOVERY_PNL_USD = 100;
export const MIN_DISCOVERY_SWAPS = 2;
export const MAX_DISCOVERY_BOUGHT_USD = 20_000;
export const MAX_DISCOVERY_GROSS_VALUE_USD = 100_000;
export const MAX_DISCOVERY_SWAPS = 100;
export const MIN_DISCOVERY_PNL_PERCENT = 100;
export const MIN_DISCOVERY_TOKEN_PNL_PERCENT = 5;
export const MAX_DISCOVERY_PNL_PERCENT = 500;
export const MIN_SOLANA_TOKEN_FLOW_BOUGHT_USD = 25;
export const MIN_SOLANA_DISCOVERY_PNL_USD = 100;

export function calculateDiscoveryPnlPercent(boughtUsd: number, estimatedPnlUsd: number) {
  return boughtUsd > 0 ? estimatedPnlUsd / boughtUsd * 100 : 0;
}

export function isDiscoveryReturnEligible(boughtUsd: number, estimatedPnlUsd: number) {
  const pnlPercent = calculateDiscoveryPnlPercent(boughtUsd, estimatedPnlUsd);
  return pnlPercent >= MIN_DISCOVERY_PNL_PERCENT
    && pnlPercent <= MAX_DISCOVERY_PNL_PERCENT;
}

export function calculateMarkToMarketPnl(boughtUsd: number, soldUsd: number, currentValueUsd: number) {
  const estimatedPnlUsd = soldUsd + currentValueUsd - boughtUsd;
  const estimatedPnlPercent = calculateDiscoveryPnlPercent(boughtUsd, estimatedPnlUsd);
  return { estimatedPnlUsd, estimatedPnlPercent };
}

export function isDiscoveryCandidateEligible(boughtUsd: number, estimatedPnlUsd: number) {
  return boughtUsd >= MIN_DISCOVERY_BOUGHT_USD
    && boughtUsd <= MAX_DISCOVERY_BOUGHT_USD
    && estimatedPnlUsd >= MIN_DISCOVERY_PNL_USD;
}

export function isDiscoveryWalletEligible(input: {
  boughtUsd: number;
  soldUsd: number;
  currentValueUsd: number;
  estimatedPnlUsd: number;
  estimatedPnlPercent: number;
  swapCount: number;
}) {
  return isDiscoveryCandidateEligible(input.boughtUsd, input.estimatedPnlUsd)
    && input.soldUsd + input.currentValueUsd <= MAX_DISCOVERY_GROSS_VALUE_USD
    && input.swapCount >= MIN_DISCOVERY_SWAPS
    && input.swapCount <= MAX_DISCOVERY_SWAPS
    && isDiscoveryReturnEligible(input.boughtUsd, input.estimatedPnlUsd);
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
    && input.swapCount <= MAX_DISCOVERY_SWAPS
    && input.buyCount > 0
    && input.sellCount > 0
    && pnlPercent >= MIN_DISCOVERY_TOKEN_PNL_PERCENT
    && pnlPercent <= MAX_DISCOVERY_PNL_PERCENT
    && isDiscoveryCandidateEligible(input.boughtUsd, input.estimatedPnlUsd);
}

export function isSolanaTokenPerformanceEligible(input: {
  boughtUsd: number;
  estimatedPnlUsd: number;
  swapCount: number;
  buyCount: number;
}) {
  const pnlPercent = input.boughtUsd > 0 ? input.estimatedPnlUsd / input.boughtUsd * 100 : 0;
  return input.swapCount >= 1
    && input.swapCount <= MAX_DISCOVERY_SWAPS
    && input.buyCount > 0
    && input.boughtUsd >= MIN_SOLANA_TOKEN_FLOW_BOUGHT_USD
    && input.boughtUsd <= MAX_DISCOVERY_BOUGHT_USD
    && input.estimatedPnlUsd > 0
    && pnlPercent >= MIN_DISCOVERY_TOKEN_PNL_PERCENT
    && pnlPercent <= MAX_DISCOVERY_PNL_PERCENT;
}

export function isSolanaDiscoveryWalletEligible(input: {
  boughtUsd: number;
  soldUsd: number;
  currentValueUsd: number;
  estimatedPnlUsd: number;
  estimatedPnlPercent: number;
  swapCount: number;
}) {
  return input.boughtUsd >= MIN_DISCOVERY_BOUGHT_USD
    && input.boughtUsd <= MAX_DISCOVERY_BOUGHT_USD
    && input.estimatedPnlUsd >= MIN_SOLANA_DISCOVERY_PNL_USD
    && input.soldUsd + input.currentValueUsd <= MAX_DISCOVERY_GROSS_VALUE_USD
    && input.swapCount >= MIN_DISCOVERY_SWAPS
    && input.swapCount <= MAX_DISCOVERY_SWAPS
    && isDiscoveryReturnEligible(input.boughtUsd, input.estimatedPnlUsd);
}
