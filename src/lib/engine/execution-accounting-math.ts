import type { ExecutionLot } from "../domain/types.ts";

export function executionLotQuantity(lot: ExecutionLot) {
  if (lot.amountFormat === "decimal") return Number(lot.amount);
  const decimals = Math.max(0, Math.min(30, lot.assetDecimals));
  return Number(lot.amount) / 10 ** decimals;
}

export function remainingExecutionCost(lot: ExecutionLot) {
  if (lot.amountFormat === "base_units") {
    const initial = BigInt(lot.initialAmount || "0");
    if (initial <= 0n) return 0;
    return lot.entryCostUsd * Number(BigInt(lot.amount) * 1_000_000n / initial) / 1_000_000;
  }
  const initial = Number(lot.initialAmount);
  return initial > 0 ? lot.entryCostUsd * Number(lot.amount) / initial : 0;
}

export function consumedExecutionCost(lots: ExecutionLot[], requestedAmount: string) {
  if (!lots.length) return 0;
  if (lots[0].amountFormat === "base_units") {
    let remaining = BigInt(requestedAmount);
    let cost = 0;
    for (const lot of lots) {
      if (remaining <= 0n) break;
      const amount = BigInt(lot.amount);
      const consumed = amount < remaining ? amount : remaining;
      const initial = BigInt(lot.initialAmount || "0");
      if (initial > 0n) cost += lot.entryCostUsd * Number(consumed * 1_000_000n / initial) / 1_000_000;
      remaining -= consumed;
    }
    return cost;
  }
  let remaining = Number(requestedAmount);
  let cost = 0;
  for (const lot of lots) {
    if (remaining <= 0) break;
    const amount = Number(lot.amount);
    const consumed = Math.min(amount, remaining);
    const initial = Number(lot.initialAmount);
    if (initial > 0) cost += lot.entryCostUsd * consumed / initial;
    remaining -= consumed;
  }
  return cost;
}

export function executionLotValueUsd(lot: ExecutionLot) {
  const quantity = executionLotQuantity(lot);
  if (lot.marketType === "perp") {
    const direction = lot.positionSide === "short" ? -1 : 1;
    const pnl = direction * (lot.currentPriceUsd - lot.entryPriceUsd) * quantity;
    return remainingExecutionCost(lot) + pnl;
  }
  return quantity * lot.currentPriceUsd;
}

export function resolveExposureLimitUsd(
  equityUsd: number,
  exposurePercent: number,
  minimumTradeUsd: number,
  minimumExecutableExposureUsd = 0,
) {
  return Math.max(equityUsd * exposurePercent / 100, minimumTradeUsd, minimumExecutableExposureUsd);
}

export function executionLotHasRealizedOutcome(lot: ExecutionLot) {
  return Math.abs(lot.realizedPnlUsd) > 0.000001;
}

export function calculatePortfolioEquity(cashBalanceUsd: number, positionValueUsd: number, reservedBalanceUsd: number) {
  return cashBalanceUsd + positionValueUsd + reservedBalanceUsd;
}

export function shouldInitializeLiveFundingBaseline(input: {
  initialEquityUsd: number;
  currentEquityUsd: number;
  hasExecutionHistory: boolean;
}) {
  return input.initialEquityUsd <= 0.01
    && input.currentEquityUsd > 0.01
    && !input.hasExecutionHistory;
}

export function calculateBalanceDifference(input: {
  equityUsd: number;
  startingEquityUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
}) {
  return input.equityUsd - input.startingEquityUsd - input.realizedPnlUsd - input.unrealizedPnlUsd;
}

export function calculateLiveAccountPnl(input: {
  equityUsd: number;
  initialEquityUsd: number;
  dailyStartEquityUsd: number;
  executionRealizedPnlUsd: number;
  unrealizedPnlUsd: number;
}) {
  const totalPnlUsd = input.equityUsd - input.initialEquityUsd;
  const realizedPnlUsd = totalPnlUsd - input.unrealizedPnlUsd;
  return {
    totalPnlUsd,
    realizedPnlUsd,
    dailyPnlUsd: input.equityUsd - input.dailyStartEquityUsd,
    accountDifferenceUsd: totalPnlUsd - input.executionRealizedPnlUsd,
  };
}
