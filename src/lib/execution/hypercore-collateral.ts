export function requiredPerpTransferAmount(perpAvailableUsd: number, spotAvailableUsd: number, requiredUsd: number) {
  const deficit = Math.max(0, requiredUsd - perpAvailableUsd);
  if (deficit === 0) return 0;
  const bufferedDeficit = Math.min(spotAvailableUsd, deficit + 0.5);
  if (bufferedDeficit + perpAvailableUsd < requiredUsd) throw new Error("Hyperliquid spot bakiyesi minimum perp teminatı için yetersiz.");
  return Math.floor(bufferedDeficit * 100) / 100;
}

export function effectiveHypercoreCollateralUsd(abstraction: string, perpAvailableUsd: number, spotAvailableUsd: number) {
  return abstraction === "unifiedAccount" ? spotAvailableUsd : perpAvailableUsd;
}

export function availableHypercoreSpotUsdc(input: {
  abstraction: string;
  totalUsd: number;
  holdUsd: number;
  availableAfterMaintenanceUsd?: number | null;
}) {
  if (input.abstraction === "unifiedAccount" && Number.isFinite(input.availableAfterMaintenanceUsd)) {
    return Math.max(0, input.availableAfterMaintenanceUsd ?? 0);
  }
  return Math.max(0, input.totalUsd - input.holdUsd);
}
