import type { ExecutionLot } from "@/lib/domain/types";

export function executionLotNetPnl(lot: ExecutionLot) {
  if (lot.status === "closed") {
    if (lot.marketType !== "perp") return lot.realizedPnlUsd;
    return lot.realizedPnlUsd - executionLotEntryFeeUsd(lot);
  }
  const quantity = lot.amountFormat === "base_units" ? Number(lot.amount) / 10 ** Math.max(0, lot.assetDecimals) : Number(lot.amount);
  if (!Number.isFinite(quantity)) return lot.realizedPnlUsd;
  if (lot.marketType === "perp") {
    const direction = lot.positionSide === "short" ? -1 : 1;
    return lot.realizedPnlUsd
      + direction * (lot.currentPriceUsd - lot.entryPriceUsd) * quantity
      - executionLotEntryFeeUsd(lot);
  }
  const initial = lot.amountFormat === "base_units" ? Number(lot.initialAmount) / 10 ** Math.max(0, lot.assetDecimals) : Number(lot.initialAmount);
  const remainingCost = initial > 0 ? lot.entryCostUsd * quantity / initial : 0;
  return lot.realizedPnlUsd + quantity * lot.currentPriceUsd - remainingCost;
}

function executionLotEntryFeeUsd(lot: ExecutionLot) {
  const initialQuantity = lot.amountFormat === "base_units"
    ? Number(lot.initialAmount) / 10 ** Math.max(0, lot.assetDecimals)
    : Number(lot.initialAmount);
  const initialMarginUsd = initialQuantity > 0
    ? initialQuantity * lot.entryPriceUsd / Math.max(1, lot.leverage)
    : 0;
  return Math.max(0, lot.entryCostUsd - initialMarginUsd);
}
