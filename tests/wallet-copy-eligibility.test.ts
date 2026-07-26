import assert from "node:assert/strict";
import test from "node:test";
import { isWalletEligibleForCopy } from "../src/lib/engine/wallet-copy-eligibility.ts";

test("aktif ve gözlemdeki cüzdanlar skordan bağımsız copy trade yapabilir", () => {
  assert.equal(isWalletEligibleForCopy("active"), true);
  assert.equal(isWalletEligibleForCopy("observing"), true);
});

test("duraklatılmış cüzdan copy trade yapamaz", () => {
  assert.equal(isWalletEligibleForCopy("paused"), false);
});
