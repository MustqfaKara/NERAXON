export interface HypercoreAccountingSpotBalance {
  coin: string;
  total: number;
  hold: number;
}

export interface HypercoreAccountingPerpState {
  accountValueUsd: number;
  withdrawableUsd: number;
  unrealizedPnlUsd: number;
}

export function calculateHypercoreAccountValues(input: {
  unified: boolean;
  spotBalances: HypercoreAccountingSpotBalance[];
  spotPricesUsd: Record<string, number>;
  perpStates: HypercoreAccountingPerpState[];
  availableUsdcAfterMaintenance?: number | null;
}) {
  const spotValueUsd = input.spotBalances.reduce((sum, balance) => {
    const priceUsd = balance.coin === "USDC" ? 1 : input.spotPricesUsd[balance.coin] ?? 0;
    return sum + Math.max(0, balance.total) * priceUsd;
  }, 0);
  const availableSpotUsdc = input.spotBalances
    .filter((balance) => balance.coin === "USDC")
    .reduce((sum, balance) => sum + Math.max(0, balance.total - balance.hold), 0);
  const perpAccountValueUsd = input.perpStates.reduce(
    (sum, state) => sum + Math.max(0, state.accountValueUsd),
    0,
  );
  const perpWithdrawableUsd = input.perpStates.reduce(
    (sum, state) => sum + Math.max(0, state.withdrawableUsd),
    0,
  );
  const perpUnrealizedPnlUsd = input.perpStates.reduce(
    (sum, state) => sum + state.unrealizedPnlUsd,
    0,
  );
  const equityUsd = input.unified
    ? Math.max(0, spotValueUsd)
    : Math.max(0, spotValueUsd + perpAccountValueUsd);
  const unifiedAvailableUsdc = Number.isFinite(input.availableUsdcAfterMaintenance)
    ? Math.max(0, input.availableUsdcAfterMaintenance ?? 0)
    : availableSpotUsdc;
  const cashBalanceUsd = input.unified
    ? Math.min(equityUsd, unifiedAvailableUsdc)
    : Math.min(equityUsd, availableSpotUsdc + perpWithdrawableUsd);
  return {
    equityUsd,
    cashBalanceUsd,
    positionValueUsd: Math.max(0, equityUsd - cashBalanceUsd),
    perpUnrealizedPnlUsd,
  };
}
