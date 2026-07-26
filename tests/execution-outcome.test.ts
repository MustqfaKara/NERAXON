import assert from "node:assert/strict";
import test from "node:test";
import { isTerminalExecutionRejection } from "../src/lib/engine/execution-outcome.ts";

test("HyperCore minimum emir reddini terminal sonuç olarak sınıflandırır", () => {
  assert.equal(isTerminalExecutionRejection("Order 0: Order must have minimum value of $10."), true);
  assert.equal(isTerminalExecutionRejection("HyperCore emri minTradeNtlRejected durumunda; fill doğrulanamadı."), true);
});

test("ağ zaman aşımını terminal borsa reddi saymaz", () => {
  assert.equal(isTerminalExecutionRejection("HyperCore Info API zaman aşımı"), false);
});
