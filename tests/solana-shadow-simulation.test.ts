import assert from "node:assert/strict";
import test from "node:test";
import { isExpectedShadowFundingError } from "../src/lib/solana/shadow-simulation.ts";

test("shadow Solana simülasyonu yalnızca finansman hatalarını beklenen kabul eder", () => {
  assert.equal(isExpectedShadowFundingError("InsufficientFundsForFee"), true);
  assert.equal(isExpectedShadowFundingError({ InstructionError: [2, "Custom"] }, ["Program log: Error: insufficient funds"]), true);
});

test("program ve slippage hataları shadow simülasyonunda gizlenmez", () => {
  assert.equal(isExpectedShadowFundingError({ InstructionError: [2, { Custom: 6001 }] }, ["Slippage tolerance exceeded"]), false);
});
