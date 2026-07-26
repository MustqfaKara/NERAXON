export function sumBaseUnitLots(amounts: string[]) {
  return amounts.reduce((sum, amount) => sum + BigInt(amount), 0n);
}

export function resolveOwnedBaseUnitSell(observedAmount: bigint, ownedAmounts: string[]) {
  const owned = sumBaseUnitLots(ownedAmounts);
  if (observedAmount <= 0n || owned <= 0n) return 0n;
  return observedAmount < owned ? observedAmount : owned;
}

export function sumDecimalLots(amounts: string[]) {
  return amounts.reduce((sum, amount) => sum + Number(amount), 0);
}

export function resolveOwnedDecimalClose(observedQuantity: number, ownedAmounts: string[]) {
  const owned = sumDecimalLots(ownedAmounts);
  if (!Number.isFinite(observedQuantity) || observedQuantity <= 0 || owned <= 0) return 0;
  return Math.min(observedQuantity, owned);
}

export function copyAllocationPercent(walletScore: number, minimum: number, maximum: number) {
  const scoreRatio = Math.min(1, Math.max(0, (walletScore - 45) / 40));
  return minimum + (maximum - minimum) * scoreRatio;
}
