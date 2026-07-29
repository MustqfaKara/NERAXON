import type { ExecutionLot } from "../domain/types.ts";
import { consumedExecutionCost } from "./execution-accounting-math.ts";

export interface ExternalBalanceAdjustment {
  expectedAmount: bigint;
  actualAmount: bigint;
  reductionAmount: bigint;
  estimatedNetProceedsUsd: number;
  estimatedCostBasisUsd: number;
  estimatedRealizedPnlUsd: number;
  hasMarketPrice: boolean;
}

export function planExternalBalanceAdjustment(
  lots: ExecutionLot[],
  actualAmount: bigint,
): ExternalBalanceAdjustment | null {
  const openLots = lots.filter((lot) => lot.status === "open" && lot.amountFormat === "base_units");
  const expectedAmount = openLots.reduce((sum, lot) => sum + BigInt(lot.amount), 0n);
  const safeActualAmount = actualAmount < 0n ? 0n : actualAmount;
  if (safeActualAmount >= expectedAmount) return null;

  const reductionAmount = expectedAmount - safeActualAmount;
  let remaining = reductionAmount;
  let estimatedNetProceedsUsd = 0;
  let hasMarketPrice = true;

  for (const lot of openLots) {
    if (remaining <= 0n) break;
    const lotAmount = BigInt(lot.amount);
    const consumed = lotAmount < remaining ? lotAmount : remaining;
    if (!(lot.currentPriceUsd > 0)) hasMarketPrice = false;
    const decimals = Math.max(0, Math.min(30, lot.assetDecimals));
    estimatedNetProceedsUsd += Number(consumed) / 10 ** decimals * Math.max(0, lot.currentPriceUsd);
    remaining -= consumed;
  }

  const estimatedCostBasisUsd = consumedExecutionCost(openLots, reductionAmount.toString());
  return {
    expectedAmount,
    actualAmount: safeActualAmount,
    reductionAmount,
    estimatedNetProceedsUsd,
    estimatedCostBasisUsd,
    estimatedRealizedPnlUsd: estimatedNetProceedsUsd - estimatedCostBasisUsd,
    hasMarketPrice,
  };
}
