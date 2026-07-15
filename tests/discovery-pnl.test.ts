import test from "node:test";
import assert from "node:assert/strict";
import { calculateMarkToMarketPnl, isDiscoveryCandidateEligible, isDiscoveryTokenPerformanceEligible } from "../src/lib/engine/discovery-pnl.ts";

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

test("100 USD altındaki alımları keşif listesinden çıkarır", () => {
  assert.equal(isDiscoveryCandidateEligible(99.99, 200), false);
});

test("100 USD altındaki tahmini kârı keşif listesinden çıkarır", () => {
  assert.equal(isDiscoveryCandidateEligible(250, 99.99), false);
  assert.equal(isDiscoveryCandidateEligible(250, 100), true);
});

test("tek yönlü veya tek swaplı token akışını akıllı cüzdan saymaz", () => {
  assert.equal(isDiscoveryTokenPerformanceEligible({ boughtUsd: 1_000, estimatedPnlUsd: 200, swapCount: 1, buyCount: 1, sellCount: 0 }), false);
  assert.equal(isDiscoveryTokenPerformanceEligible({ boughtUsd: 1_000, estimatedPnlUsd: 200, swapCount: 2, buyCount: 1, sellCount: 1 }), true);
});

test("gerçek dışı ROI üreten akışı keşiften çıkarır", () => {
  assert.equal(isDiscoveryTokenPerformanceEligible({ boughtUsd: 100, estimatedPnlUsd: 501, swapCount: 2, buyCount: 1, sellCount: 1 }), false);
});
