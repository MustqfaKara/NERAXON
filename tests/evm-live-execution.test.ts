import assert from "node:assert/strict";
import test from "node:test";
import { calculateNativeBuyAmount, calculateTokenSellAmount, quoteNativeValueUsd } from "../src/lib/execution/evm-execution-math.ts";

test("ETH alım miktarı gas rezervinden sonra bakiye yüzdesine göre hesaplanır", () => {
  const amount = calculateNativeBuyAmount(100_000n, 10, 20_000n);
  assert.equal(amount, 8_000n);
});

test("token satış miktarı seçilen yüzdeyi aşmaz", () => {
  assert.equal(calculateTokenSellAmount(1_000_000n, 25), 250_000n);
  assert.equal(calculateTokenSellAmount(1_000_000n, 100), 1_000_000n);
});

test("EVM satış riski kaynak cüzdan miktarı yerine quote ETH çıktısını kullanır", () => {
  assert.equal(quoteNativeValueUsd("sell", 1_000_000n, 5_000_000_000_000_000n, 2_000), 10);
});
