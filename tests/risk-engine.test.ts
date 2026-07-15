import test from "node:test";
import assert from "node:assert/strict";
import { evaluateBuy } from "../src/lib/engine/risk-engine.ts";

const settings = {
  minPositionPercent: 5,
  maxPositionPercent: 10,
  dailyLossLimitPercent: 8,
  maxOpenPositions: 6,
  maxTokenExposurePercent: 15,
  maxWalletExposurePercent: 25,
  minimumLiquidityUsd: 50_000,
  maxSlippagePercent: 2,
  maxPriceImpactPercent: 2.5,
  cashReservePercent: 20,
};
const context = {
  equityUsd: 100,
  cashBalanceUsd: 100,
  openPositions: [],
  walletScore: 85,
  liquidityUsd: 500_000,
  slippagePercent: 0.5,
  priceImpactPercent: 0.1,
  dailyPnlUsd: 0,
};

test("yüksek skorlu işlem için yüzde 10'a yakın pozisyon ayırır", () => {
  const result = evaluateBuy(settings, {
    equityUsd: 100,
    cashBalanceUsd: 100,
    openPositions: [],
    walletScore: 85,
    liquidityUsd: 500_000,
    slippagePercent: 0.5,
    priceImpactPercent: 0.1,
    dailyPnlUsd: 0,
  });
  assert.equal(result.approved, true);
  assert.equal(result.allocationUsd, 10);
});

test("düşük likiditeli işlemi reddeder", () => {
  const result = evaluateBuy(settings, {
    equityUsd: 100,
    cashBalanceUsd: 100,
    openPositions: [],
    walletScore: 80,
    liquidityUsd: 10_000,
    slippagePercent: 0.5,
    priceImpactPercent: 0.1,
    dailyPnlUsd: 0,
  });
  assert.equal(result.approved, false);
  assert.match(result.reason, /likiditesi/);
});

test("mevcut tokenın konsensüs alımı açık pozisyon sayısı sınırına takılmaz", () => {
  const decision = evaluateBuy(settings, {
    ...context,
    openPositions: Array.from({ length: settings.maxOpenPositions }, (_, index) => ({ id: String(index), chainId: "base" as const, tokenAddress: `0x${String(index).padStart(40, "0")}`, tokenSymbol: "TEST", pairAddress: null, sourceWalletId: null, sourceWalletLabel: null, quantity: 1, averageEntryUsd: 1, currentPriceUsd: 1, investedUsd: 1, unrealizedPnlUsd: 0, updatedAt: new Date(0).toISOString() })),
    isExistingTokenPosition: true,
  });
  assert.equal(decision.approved, true);
});

test("token maruziyet üst sınırını aşacak alımı reddeder", () => {
  const decision = evaluateBuy(settings, {
    ...context,
    tokenExposureUsd: 14,
    equityUsd: 100,
  });
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /Token bazlı/u);
});

test("aktif devre kesici bütün yeni alımları reddeder", () => {
  const decision = evaluateBuy(settings, { ...context, circuitBreakerHalted: true });
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /devre kesicisi/u);
});
