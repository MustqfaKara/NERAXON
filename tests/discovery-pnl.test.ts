import test from "node:test";
import assert from "node:assert/strict";
import { calculateDiscoveryPnlPercent, calculateMarkToMarketPnl, isDiscoveryCandidateEligible, isDiscoveryReturnEligible, isDiscoveryTokenPerformanceEligible, isDiscoveryWalletEligible, MIN_SOLANA_DISCOVERY_PNL_USD } from "../src/lib/engine/discovery-pnl.ts";

test("satış ve elde kalan değeri alım maliyetine karşı PnL olarak hesaplar", () => {
  const result = calculateMarkToMarketPnl(1_000, 700, 500);
  assert.equal(result.estimatedPnlUsd, 200);
  assert.equal(result.estimatedPnlPercent, 20);
});

test("alım maliyeti yoksa PnL yüzdesini sıfır tutar", () => {
  const result = calculateMarkToMarketPnl(0, 100, 0);
  assert.equal(result.estimatedPnlUsd, 100);
  assert.equal(result.estimatedPnlPercent, 0);
});

test("tüm ağlar için PnL katını gerçek alım maliyetinden hesaplar", () => {
  assert.equal(calculateDiscoveryPnlPercent(250, 500), 200);
  assert.equal(isDiscoveryReturnEligible(250, 249.99), false);
  assert.equal(isDiscoveryReturnEligible(250, 250), true);
  assert.equal(isDiscoveryReturnEligible(250, 1_251), false);
});

test("100 USD altındaki alımları keşif listesinden çıkarır", () => {
  assert.equal(isDiscoveryCandidateEligible(99.99, 200), false);
});

test("100 USD altındaki tahmini kârı keşif listesinden çıkarır", () => {
  assert.equal(isDiscoveryCandidateEligible(250, 99.99), false);
  assert.equal(isDiscoveryCandidateEligible(250, 100), true);
});

test("20 bin USD üzerindeki sermayeyi degen keşif evreninden çıkarır", () => {
  assert.equal(isDiscoveryCandidateEligible(20_000, 500), true);
  assert.equal(isDiscoveryCandidateEligible(20_000.01, 500), false);
});

test("milyonluk brüt değeri ve aşırı işlem sayısını reddeder", () => {
  assert.equal(isDiscoveryWalletEligible({ boughtUsd: 5_000, soldUsd: 1_000_000, currentValueUsd: 0, estimatedPnlUsd: 500, estimatedPnlPercent: 10, swapCount: 12 }), false);
  assert.equal(isDiscoveryWalletEligible({ boughtUsd: 5_000, soldUsd: 5_500, currentValueUsd: 0, estimatedPnlUsd: 500, estimatedPnlPercent: 10, swapCount: 101 }), false);
  assert.equal(isDiscoveryWalletEligible({ boughtUsd: 5_000, soldUsd: 5_500, currentValueUsd: 0, estimatedPnlUsd: 500, estimatedPnlPercent: 10, swapCount: 12 }), false);
  assert.equal(isDiscoveryWalletEligible({ boughtUsd: 5_000, soldUsd: 10_000, currentValueUsd: 0, estimatedPnlUsd: 5_000, estimatedPnlPercent: 100, swapCount: 12 }), true);
});

test("tek yönlü veya tek swaplı token akışını akıllı cüzdan saymaz", () => {
  assert.equal(isDiscoveryTokenPerformanceEligible({ boughtUsd: 1_000, estimatedPnlUsd: 200, swapCount: 1, buyCount: 1, sellCount: 0 }), false);
  assert.equal(isDiscoveryTokenPerformanceEligible({ boughtUsd: 1_000, estimatedPnlUsd: 200, swapCount: 2, buyCount: 1, sellCount: 1 }), true);
});

test("gerçek dışı ROI üreten akışı keşiften çıkarır", () => {
  assert.equal(isDiscoveryTokenPerformanceEligible({ boughtUsd: 100, estimatedPnlUsd: 501, swapCount: 2, buyCount: 1, sellCount: 1 }), false);
});

test("yüzde 5 altındaki verimsiz akışı keşiften çıkarır", () => {
  assert.equal(isDiscoveryTokenPerformanceEligible({ boughtUsd: 10_000, estimatedPnlUsd: 499, swapCount: 4, buyCount: 2, sellCount: 2 }), false);
  assert.equal(isDiscoveryTokenPerformanceEligible({ boughtUsd: 10_000, estimatedPnlUsd: 500, swapCount: 4, buyCount: 2, sellCount: 2 }), true);
});

test("Solana keşfi en az 100 USD net PnL ister", () => {
  assert.equal(MIN_SOLANA_DISCOVERY_PNL_USD, 100);
});
