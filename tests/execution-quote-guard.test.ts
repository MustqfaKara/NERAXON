import assert from "node:assert/strict";
import test from "node:test";
import type { RiskSettings } from "../src/lib/domain/types.ts";
import { assertPriceDeviation, prepareFreshQuote, StaleQuoteError } from "../src/lib/execution/execution-quote-guard.ts";

const executionLimit = {
  minPositionPercent: 8,
  maxPositionPercent: 15,
  minTradeUsd: 0,
  maxTradeUsd: 5,
  dailyLossLimitPercent: 10,
  cashReservePercent: 15,
  maxOpenPositions: 4,
  maxSlippagePercent: 2,
  maxLeverage: 1,
  maxQuoteAgeMs: 8_000,
  maxBuyPriceDeviationPercent: 3,
  maxSellPriceDeviationPercent: 6,
  maxEmergencyExitDeviationPercent: 12,
};

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
    ethereum: { ...executionLimit },
    base: { ...executionLimit },
    robinhood: { ...executionLimit },
    solana: { ...executionLimit, maxQuoteAgeMs: 5_000, maxBuyPriceDeviationPercent: 5, maxSellPriceDeviationPercent: 8 },
    hyperliquid: { ...executionLimit, maxQuoteAgeMs: 3_000, maxBuyPriceDeviationPercent: 2, maxSellPriceDeviationPercent: 5 },
  },
};

test("güncel quote ilk hazırlamada kabul edilir", async () => {
  let calls = 0;
  const result = await prepareFreshQuote({
    chainId: "base",
    settings,
    prepare: async () => ({ quotedAt: new Date().toISOString(), call: ++calls }),
    quotedAt: (plan) => plan.quotedAt,
  });
  assert.equal(result.quoteRefreshed, false);
  assert.equal(result.plan.call, 1);
});

test("eski quote bir kez otomatik yenilenir", async () => {
  let calls = 0;
  const result = await prepareFreshQuote({
    chainId: "solana",
    settings,
    prepare: async () => ({ quotedAt: ++calls === 1 ? new Date(Date.now() - 10_000).toISOString() : new Date().toISOString() }),
    quotedAt: (plan) => plan.quotedAt,
  });
  assert.equal(result.quoteRefreshed, true);
  assert.equal(calls, 2);
});

test("yenilenen quote da eski ise emir reddedilir", async () => {
  let calls = 0;
  await assert.rejects(
    prepareFreshQuote({
      chainId: "hyperliquid",
      settings,
      prepare: async () => ({ quotedAt: new Date(Date.now() - 10_000).toISOString(), call: ++calls }),
      quotedAt: (plan) => plan.quotedAt,
    }),
    StaleQuoteError,
  );
  assert.equal(calls, 2);
});

test("ağ ve işlem yönü fiyat sapması sınırını belirler", () => {
  const baseInput = {
    chainId: "base" as const,
    referencePriceUsd: 100,
    quotedAt: new Date().toISOString(),
    quoteRefreshed: false,
    settings,
  };
  assert.throws(() => assertPriceDeviation({ ...baseInput, side: "buy", quotedPriceUsd: 103.01 }), /sınırını aşıyor/);
  assert.doesNotThrow(() => assertPriceDeviation({ ...baseInput, side: "sell", quotedPriceUsd: 94 }));
  assert.doesNotThrow(() => assertPriceDeviation({ ...baseInput, side: "sell", quotedPriceUsd: 88, emergencyExit: true }));
  assert.throws(() => assertPriceDeviation({ ...baseInput, side: "sell", quotedPriceUsd: 87.99, emergencyExit: true }), /sınırını aşıyor/);
});
