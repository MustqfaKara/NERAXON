import test from "node:test";
import assert from "node:assert/strict";
import { hasMeaningfulBaseUnitBalance, hasMeaningfulDecimalBalance } from "../src/lib/engine/source-balance.ts";

test("18 decimal tokenlarda mikro token altındaki dust bakiyeyi pozisyon saymaz", () => {
  assert.equal(hasMeaningfulBaseUnitBalance(3_172n, 18), false);
  assert.equal(hasMeaningfulBaseUnitBalance(10n ** 12n, 18), true);
});

test("düşük decimal token bakiyesini doğru eşikle değerlendirir", () => {
  assert.equal(hasMeaningfulBaseUnitBalance(0n, 6), false);
  assert.equal(hasMeaningfulBaseUnitBalance(1n, 6), true);
});

test("HyperCore decimal dust bakiyeyi pozisyon saymaz", () => {
  assert.equal(hasMeaningfulDecimalBalance(1e-9), false);
  assert.equal(hasMeaningfulDecimalBalance(0.000001), true);
});
