import assert from "node:assert/strict";
import test from "node:test";
import { calculateHypercorePnl } from "../src/lib/engine/hypercore-position.ts";

test("HyperCore long pozisyon PnL değerini fiyat artışıyla hesaplar", () => {
  assert.equal(calculateHypercorePnl("long", 100, 110, 2), 20);
});

test("HyperCore short pozisyon PnL değerini fiyat düşüşüyle hesaplar", () => {
  assert.equal(calculateHypercorePnl("short", 100, 90, 3), 30);
});

test("HyperCore short pozisyon fiyat yükseldiğinde zarar üretir", () => {
  assert.equal(calculateHypercorePnl("short", 100, 105, 4), -20);
});
