export function calculateSellQuantity(
  positionQuantity: number,
  sellPercent?: number,
  requestedQuantity?: number,
) {
  if (requestedQuantity && requestedQuantity > 0) {
    return Math.min(requestedQuantity, positionQuantity);
  }
  if (sellPercent) {
    const normalizedPercent = Math.min(100, Math.max(1, sellPercent));
    return positionQuantity * (normalizedPercent / 100);
  }
  return positionQuantity;
}
