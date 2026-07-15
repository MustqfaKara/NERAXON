import test from "node:test";
import assert from "node:assert/strict";
import { calculateSellQuantity } from "../src/lib/engine/position-sizing.ts";

test("pozisyonun seçilen yüzdesini satış miktarına dönüştürür", () => {
  assert.equal(calculateSellQuantity(20, 25), 5);
});

test("satış yüzdesini pozisyonun tamamıyla sınırlar", () => {
  assert.equal(calculateSellQuantity(20, 150), 20);
});

test("kopya satışında açık miktardan fazlasını satmaz", () => {
  assert.equal(calculateSellQuantity(20, undefined, 30), 20);
});
