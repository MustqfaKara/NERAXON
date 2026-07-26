import test from "node:test";
import assert from "node:assert/strict";
import { calculateGasFeeUsd } from "../src/lib/services/gas-calculation.ts";

test("Ethereum gas maliyetini güncel gas price modeliyle USD'ye çevirir", () => {
  const fee = calculateGasFeeUsd("ethereum", 2_000_000_000n, 180_000n, 3_000);
  assert.equal(fee, 1.08);
});

test("Base tahminine maliyetle orantılı L1 veri tamponu ekler", () => {
  const fee = calculateGasFeeUsd("base", 1_000_000n, 300_000n, 3_000);
  assert.ok(Math.abs(fee - 0.0019) < 1e-12);
});

test("Base L1 tamponu yüksek gas maliyetinde yüzde 25 ile ölçeklenir", () => {
  const fee = calculateGasFeeUsd("base", 10_000_000n, 300_000n, 3_000);
  assert.ok(Math.abs(fee - 0.01125) < 1e-12);
});
