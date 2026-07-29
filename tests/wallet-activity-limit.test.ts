import assert from "node:assert/strict";
import test from "node:test";
import { evaluateWalletActivityLimit, walletActivityLimitsFor } from "../src/lib/engine/wallet-activity-limit.ts";

const activitySettings = {
  maxWalletSwapsPerHour: 8,
  maxWalletSwapsPer24Hours: 50,
  hypercoreMaxWalletFillsPerHour: 20,
  hypercoreMaxWalletFillsPer24Hours: 100,
};

test("sınırdaki swap sayısına izin verir", () => {
  assert.deepEqual(evaluateWalletActivityLimit({
    swapsLastHour: 8,
    swapsLast24Hours: 50,
    maxSwapsPerHour: 8,
    maxSwapsPer24Hours: 50,
  }), { exceeded: false, reason: null });
});

test("saatlik sınır aşıldığında cüzdanı engeller", () => {
  const result = evaluateWalletActivityLimit({
    swapsLastHour: 9,
    swapsLast24Hours: 12,
    maxSwapsPerHour: 8,
    maxSwapsPer24Hours: 50,
  });
  assert.equal(result.exceeded, true);
  assert.match(result.reason ?? "", /Son 1 saatte 9 swap/);
});

test("24 saatlik sınır aşıldığında cüzdanı engeller", () => {
  const result = evaluateWalletActivityLimit({
    swapsLastHour: 2,
    swapsLast24Hours: 51,
    maxSwapsPerHour: 8,
    maxSwapsPer24Hours: 50,
  });
  assert.equal(result.exceeded, true);
  assert.match(result.reason ?? "", /Son 24 saatte 51 swap/);
});

test("HyperCore fill yoğunluğu diğer ağlardan bağımsız daha esnek sınır kullanır", () => {
  assert.deepEqual(walletActivityLimitsFor("base", activitySettings), {
    maxSwapsPerHour: 8,
    maxSwapsPer24Hours: 50,
  });
  assert.deepEqual(walletActivityLimitsFor("hyperliquid", activitySettings), {
    maxSwapsPerHour: 20,
    maxSwapsPer24Hours: 100,
  });
});
