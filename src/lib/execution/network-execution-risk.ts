import type { ChainId, NetworkExecutionLimit, RiskSettings } from "@/lib/domain/types";

const HYPERCORE_TICK_TOLERANCE_MULTIPLIER = 1.3;

const FALLBACK_LIMITS: Record<ChainId, NetworkExecutionLimit> = {
  ethereum: { minPositionPercent: 8, maxPositionPercent: 15, minTradeUsd: 0, maxTradeUsd: 5, dailyLossLimitPercent: 10, cashReservePercent: 15, maxOpenPositions: 4, maxSlippagePercent: 2, maxLeverage: 1, maxQuoteAgeMs: 8_000, maxBuyPriceDeviationPercent: 3, maxSellPriceDeviationPercent: 6, maxEmergencyExitDeviationPercent: 12 },
  base: { minPositionPercent: 8, maxPositionPercent: 15, minTradeUsd: 0, maxTradeUsd: 5, dailyLossLimitPercent: 10, cashReservePercent: 15, maxOpenPositions: 4, maxSlippagePercent: 2, maxLeverage: 1, maxQuoteAgeMs: 8_000, maxBuyPriceDeviationPercent: 3, maxSellPriceDeviationPercent: 6, maxEmergencyExitDeviationPercent: 12 },
  robinhood: { minPositionPercent: 8, maxPositionPercent: 15, minTradeUsd: 0, maxTradeUsd: 5, dailyLossLimitPercent: 10, cashReservePercent: 15, maxOpenPositions: 4, maxSlippagePercent: 2, maxLeverage: 1, maxQuoteAgeMs: 8_000, maxBuyPriceDeviationPercent: 3, maxSellPriceDeviationPercent: 6, maxEmergencyExitDeviationPercent: 12 },
  solana: { minPositionPercent: 8, maxPositionPercent: 15, minTradeUsd: 0, maxTradeUsd: 5, dailyLossLimitPercent: 10, cashReservePercent: 15, maxOpenPositions: 4, maxSlippagePercent: 3, maxLeverage: 1, maxQuoteAgeMs: 5_000, maxBuyPriceDeviationPercent: 5, maxSellPriceDeviationPercent: 8, maxEmergencyExitDeviationPercent: 12 },
  hyperliquid: { minPositionPercent: 8, maxPositionPercent: 15, minTradeUsd: 10.5, maxTradeUsd: 12, dailyLossLimitPercent: 10, cashReservePercent: 15, maxOpenPositions: 2, maxSlippagePercent: 1.5, maxLeverage: 2, maxQuoteAgeMs: 3_000, maxBuyPriceDeviationPercent: 2, maxSellPriceDeviationPercent: 5, maxEmergencyExitDeviationPercent: 12 },
};

export function getNetworkExecutionLimit(chainId: ChainId, settings: RiskSettings) {
  const configured = settings.networkExecutionLimits?.[chainId] ?? FALLBACK_LIMITS[chainId];
  return chainId === "hyperliquid" ? { ...configured, minTradeUsd: Math.max(10.5, configured.minTradeUsd) } : configured;
}

export function assertNetworkExecutionLimit(input: {
  chainId: ChainId;
  tradeUsd: number;
  slippagePercent: number;
  leverage?: number;
  minimumTradableNotionalUsd?: number;
  side: "buy" | "sell" | "open" | "close";
  settings: RiskSettings;
}) {
  const limit = getNetworkExecutionLimit(input.chainId, input.settings);
  const maximumTradeUsd = input.chainId === "hyperliquid" && input.minimumTradableNotionalUsd
    ? hypercoreTickAdjustedMaximumUsd(limit.maxTradeUsd, input.minimumTradableNotionalUsd)
    : limit.maxTradeUsd;
  if (!Number.isFinite(input.tradeUsd) || input.tradeUsd <= 0) throw new Error("İşlem USD değeri doğrulanamadı.");
  const opensPosition = input.side === "buy" || input.side === "open";
  if (opensPosition && input.tradeUsd > maximumTradeUsd + 0.01) {
    throw new Error(`${input.chainId} işlemi ${input.tradeUsd.toFixed(2)} USD ile ${maximumTradeUsd.toFixed(2)} USD ağ tavanını aşıyor.`);
  }
  if (opensPosition && limit.minTradeUsd > 0 && input.tradeUsd + 0.01 < limit.minTradeUsd) {
    throw new Error(`${input.chainId} işlemi en az ${limit.minTradeUsd.toFixed(2)} USD olmalı.`);
  }
  if (input.slippagePercent > limit.maxSlippagePercent + Number.EPSILON) {
    throw new Error(`${input.chainId} slippage oranı %${limit.maxSlippagePercent.toFixed(2)} sınırını aşıyor.`);
  }
  if ((input.leverage ?? 1) > limit.maxLeverage) {
    throw new Error(`${input.chainId} kaldıraç oranı ${limit.maxLeverage}x sınırını aşıyor.`);
  }
  return limit;
}

export function hypercoreTickAdjustedMaximumUsd(configuredMaximumUsd: number, minimumTradableNotionalUsd: number) {
  if (minimumTradableNotionalUsd <= configuredMaximumUsd) return configuredMaximumUsd;
  return minimumTradableNotionalUsd <= configuredMaximumUsd * HYPERCORE_TICK_TOLERANCE_MULTIPLIER + 0.01
    ? minimumTradableNotionalUsd
    : configuredMaximumUsd;
}

export function clampHypercoreNotional(desiredUsd: number, availableCollateralUsd: number, leverage: number, settings: RiskSettings) {
  const limit = getNetworkExecutionLimit("hyperliquid", settings);
  const reserveAdjustedCapacity = availableCollateralUsd * (1 - limit.cashReservePercent / 100) * leverage;
  return Math.min(limit.maxTradeUsd, reserveAdjustedCapacity, Math.max(limit.minTradeUsd, desiredUsd));
}
