import type { ExecutionLot } from "../domain/types.ts";
import { executionLotQuantity, remainingExecutionCost } from "../engine/execution-accounting-math.ts";

export interface OpenPositionBalanceSummary {
  allocatedCapitalUsd: number;
  marketExposureUsd: number;
  positionCount: number;
}

export function summarizeOpenPositionBalances(lots: ExecutionLot[]): OpenPositionBalanceSummary {
  const openLots = lots.filter((lot) => lot.status === "open");
  const positionKeys = new Set<string>();
  let allocatedCapitalUsd = 0;
  let marketExposureUsd = 0;

  for (const lot of openLots) {
    const quantity = executionLotQuantity(lot);
    allocatedCapitalUsd += remainingExecutionCost(lot);
    marketExposureUsd += Math.max(0, quantity * lot.currentPriceUsd);
    positionKeys.add(`${lot.integrationId}:${lot.assetKey.toLowerCase()}:${lot.positionSide ?? "spot"}`);
  }

  return {
    allocatedCapitalUsd,
    marketExposureUsd,
    positionCount: positionKeys.size,
  };
}
