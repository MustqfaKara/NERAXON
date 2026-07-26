export function resolveLivePositionLimit(input: {
  equityUsd: number;
  estimatedTradeUsd: number;
  configuredLimit: number;
  globalLimit: number;
  cashReservePercent: number;
  minPositionPercent: number;
  minTradeUsd: number;
}) {
  const configuredLimit = Math.max(1, Math.trunc(input.configuredLimit));
  const globalLimit = Math.max(configuredLimit, Math.trunc(input.globalLimit));
  const investableUsd = Math.max(0, input.equityUsd * (1 - input.cashReservePercent / 100));
  const minimumPositionUsd = input.equityUsd * input.minPositionPercent / 100;
  const sizingUnitUsd = Math.max(0.5, input.estimatedTradeUsd, input.minTradeUsd, minimumPositionUsd);
  const capacityLimit = Math.max(1, Math.floor(investableUsd / sizingUnitUsd));
  return Math.min(globalLimit, Math.max(configuredLimit, capacityLimit));
}
