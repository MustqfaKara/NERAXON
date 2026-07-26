const MIN_MEANINGFUL_TOKEN_UNITS = 0.000001;

export function hasMeaningfulBaseUnitBalance(rawAmount: bigint, decimals: number): boolean {
  if (rawAmount <= 0n) return false;
  const safeDecimals = Math.max(0, Math.min(255, Math.trunc(decimals)));
  const thresholdDecimals = Math.max(0, safeDecimals - 6);
  const minimumRawAmount = 10n ** BigInt(thresholdDecimals);
  return rawAmount >= minimumRawAmount;
}

export function hasMeaningfulDecimalBalance(amount: number): boolean {
  return Number.isFinite(amount) && amount >= MIN_MEANINGFUL_TOKEN_UNITS;
}
