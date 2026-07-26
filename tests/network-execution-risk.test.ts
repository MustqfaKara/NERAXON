import assert from "node:assert/strict";
import test from "node:test";
import type { RiskSettings } from "../src/lib/domain/types.ts";
import { assertNetworkExecutionLimit, clampHypercoreNotional, getNetworkExecutionLimit, hypercoreTickAdjustedMaximumUsd } from "../src/lib/execution/network-execution-risk.ts";

const settings: RiskSettings = {
  minPositionPercent: 8,
  maxPositionPercent: 15,
  dailyLossLimitPercent: 10,
  maxOpenPositions: 12,
  maxTokenExposurePercent: 20,
  maxWalletExposurePercent: 30,
  minimumLiquidityUsd: 50_000,
  maxSlippagePercent: 3,
  maxPriceImpactPercent: 3,
  cashReservePercent: 15,
  networkExecutionLimits: {
    ethereum: { minPositionPercent: 8, maxPositionPercent: 15, minTradeUsd: 0, maxTradeUsd: 5, dailyLossLimitPercent: 10, cashReservePercent: 15, maxOpenPositions: 4, maxSlippagePercent: 2, maxLeverage: 1, maxQuoteAgeMs: 8_000, maxBuyPriceDeviationPercent: 3, maxSellPriceDeviationPercent: 6, maxEmergencyExitDeviationPercent: 12 },
    base: { minPositionPercent: 8, maxPositionPercent: 15, minTradeUsd: 0, maxTradeUsd: 5, dailyLossLimitPercent: 10, cashReservePercent: 15, maxOpenPositions: 4, maxSlippagePercent: 2, maxLeverage: 1, maxQuoteAgeMs: 8_000, maxBuyPriceDeviationPercent: 3, maxSellPriceDeviationPercent: 6, maxEmergencyExitDeviationPercent: 12 },
    robinhood: { minPositionPercent: 8, maxPositionPercent: 15, minTradeUsd: 0, maxTradeUsd: 5, dailyLossLimitPercent: 10, cashReservePercent: 15, maxOpenPositions: 4, maxSlippagePercent: 2, maxLeverage: 1, maxQuoteAgeMs: 8_000, maxBuyPriceDeviationPercent: 3, maxSellPriceDeviationPercent: 6, maxEmergencyExitDeviationPercent: 12 },
    solana: { minPositionPercent: 8, maxPositionPercent: 15, minTradeUsd: 0, maxTradeUsd: 5, dailyLossLimitPercent: 10, cashReservePercent: 15, maxOpenPositions: 4, maxSlippagePercent: 3, maxLeverage: 1, maxQuoteAgeMs: 5_000, maxBuyPriceDeviationPercent: 5, maxSellPriceDeviationPercent: 8, maxEmergencyExitDeviationPercent: 12 },
    hyperliquid: { minPositionPercent: 8, maxPositionPercent: 15, minTradeUsd: 10, maxTradeUsd: 12, dailyLossLimitPercent: 10, cashReservePercent: 15, maxOpenPositions: 2, maxSlippagePercent: 1.5, maxLeverage: 2, maxQuoteAgeMs: 3_000, maxBuyPriceDeviationPercent: 2, maxSellPriceDeviationPercent: 5, maxEmergencyExitDeviationPercent: 12 },
  },
};

test("Base ve Solana açılışları ağ başına 5 USD tavanını kullanır", () => {
  assert.equal(getNetworkExecutionLimit("base", settings).maxTradeUsd, 5);
  assert.equal(getNetworkExecutionLimit("solana", settings).maxTradeUsd, 5);
  assert.throws(() => assertNetworkExecutionLimit({ chainId: "base", tradeUsd: 5.02, slippagePercent: 1, side: "buy", settings }), /ağ tavanını aşıyor/);
});

test("HyperCore açılışı 10.5-12 USD ve 2x aralığında tutulur", () => {
  assert.throws(() => assertNetworkExecutionLimit({ chainId: "hyperliquid", tradeUsd: 9.9, slippagePercent: 1, leverage: 2, side: "open", settings }), /en az 10\.50 USD/);
  assert.throws(() => assertNetworkExecutionLimit({ chainId: "hyperliquid", tradeUsd: 12.1, slippagePercent: 1, leverage: 2, side: "open", settings }), /12\.00 USD ağ tavanını/);
  assert.throws(() => assertNetworkExecutionLimit({ chainId: "hyperliquid", tradeUsd: 11, slippagePercent: 1, leverage: 3, side: "open", settings }), /2x sınırını/);
});

test("HyperCore minimum piyasa ticki yüzde 30 tolerans içinde tavanı kontrollü aşabilir", () => {
  const minimumTickUsd = 14.9926;
  assert.equal(hypercoreTickAdjustedMaximumUsd(12, minimumTickUsd), minimumTickUsd);
  assert.doesNotThrow(() => assertNetworkExecutionLimit({ chainId: "hyperliquid", tradeUsd: minimumTickUsd, minimumTradableNotionalUsd: minimumTickUsd, slippagePercent: 0.5, leverage: 2, side: "open", settings }));
  assert.equal(hypercoreTickAdjustedMaximumUsd(12, 16), 12);
});

test("pozisyon kapatma emri işlem büyüklüğü tavanına takılmaz", () => {
  const limit = assertNetworkExecutionLimit({ chainId: "base", tradeUsd: 30, slippagePercent: 1, side: "sell", settings });
  assert.equal(limit.maxTradeUsd, 5);
});

test("HyperCore notional minimumu rezerv ve kullanılabilir teminatı aşmaz", () => {
  assert.equal(clampHypercoreNotional(4, 33.33, 2, settings), 10.5);
  assert.equal(clampHypercoreNotional(20, 33.33, 2, settings), 12);
  assert.equal(clampHypercoreNotional(10, 5, 2, settings), 8.5);
});
