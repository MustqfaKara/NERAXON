import assert from "node:assert/strict";
import test from "node:test";
import { copyAllocationPercent, resolveOwnedBaseUnitSell, resolveOwnedDecimalClose, sumBaseUnitLots } from "../src/lib/execution/execution-lot-math.ts";

test("EVM satış miktarı yalnızca kaynak cüzdanın lotlarıyla sınırlanır", () => {
  assert.equal(resolveOwnedBaseUnitSell(900n, ["200", "300"]), 500n);
  assert.equal(resolveOwnedBaseUnitSell(250n, ["200", "300"]), 250n);
});

test("başka cüzdanın lotu kaynak cüzdan toplamına eklenmez", () => {
  const walletALots = ["100", "150"];
  const walletBLots = ["900"];
  assert.equal(sumBaseUnitLots(walletALots), 250n);
  assert.equal(resolveOwnedBaseUnitSell(800n, walletALots), 250n);
  assert.equal(resolveOwnedBaseUnitSell(800n, walletBLots), 800n);
});

test("HyperCore kapatma miktarı sahip olunan lotu aşmaz", () => {
  assert.equal(resolveOwnedDecimalClose(4, ["1.25", "0.75"]), 2);
  assert.equal(resolveOwnedDecimalClose(0.5, ["1.25", "0.75"]), 0.5);
});

test("cüzdan skoru canlı bütçe oranını risk aralığında tutar", () => {
  assert.equal(copyAllocationPercent(45, 5, 10), 5);
  assert.equal(copyAllocationPercent(85, 5, 10), 10);
  assert.equal(copyAllocationPercent(100, 5, 10), 10);
});
