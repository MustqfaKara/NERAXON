import assert from "node:assert/strict";
import test from "node:test";
import { evaluateWalletActivityLimit } from "../src/lib/engine/wallet-activity-limit.ts";

test("sınırdaki swap sayısına izin verir", () => {
  assert.deepEqual(evaluateWalletActivityLimit({
    swapsLastHour: 8,
    swapsLast24Hours: 25,
    maxSwapsPerHour: 8,
    maxSwapsPer24Hours: 25,
  }), { exceeded: false, reason: null });
});

test("saatlik sınır aşıldığında cüzdanı engeller", () => {
  const result = evaluateWalletActivityLimit({
    swapsLastHour: 9,
    swapsLast24Hours: 12,
    maxSwapsPerHour: 8,
    maxSwapsPer24Hours: 25,
  });
  assert.equal(result.exceeded, true);
  assert.match(result.reason ?? "", /Son 1 saatte 9 swap/);
});

test("24 saatlik sınır aşıldığında cüzdanı engeller", () => {
  const result = evaluateWalletActivityLimit({
    swapsLastHour: 2,
    swapsLast24Hours: 26,
    maxSwapsPerHour: 8,
    maxSwapsPer24Hours: 25,
  });
  assert.equal(result.exceeded, true);
  assert.match(result.reason ?? "", /Son 24 saatte 26 swap/);
});
