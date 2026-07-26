import test from "node:test";
import assert from "node:assert/strict";
import { classifyTransaction, classifyTransactionWithInspection } from "../src/lib/chains/transaction-classifier.ts";

test("Universal Router işlemini swap olarak sınıflandırır", () => {
  assert.equal(classifyTransaction("0x3593564c1234"), "swap");
});

test("Uniswap V2 fee-on-transfer ETH alımını swap olarak sınıflandırır", () => {
  assert.equal(classifyTransaction("0xb6f9de951234"), "swap");
});

test("Uniswap V2 fee-on-transfer token satışını swap olarak sınıflandırır", () => {
  assert.equal(classifyTransaction("0x791ac9471234"), "swap");
});

test("bilinmeyen selector için receipt ve router bilgisinden swap sonucunu çıkarır", () => {
  const result = classifyTransactionWithInspection("0xdeadbeef", {
    targetAddress: "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
    nativeValue: 0.01518289,
    tokenMovements: [{ direction: "in" }],
  });

  assert.equal(result.activity, "swap");
  assert.match(result.reason, /DEX router/);
});

test("tek yönlü sıradan token hareketini swap olarak işaretlemez", () => {
  const result = classifyTransactionWithInspection("0xdeadbeef", {
    targetAddress: "0x1111111111111111111111111111111111111111",
    nativeValue: 0,
    tokenMovements: [{ direction: "in" }],
  });

  assert.equal(result.activity, "contract");
});

test("Base DexRouter tek yönlü token çıkışını swap olarak sınıflandırır", () => {
  const result = classifyTransactionWithInspection("0xf2c42696", {
    targetAddress: "0xc8f6b8ba0dc0f175b568b99440b0867f69a29265",
    nativeValue: 0,
    tokenMovements: [{ direction: "out" }],
  });

  assert.equal(result.activity, "swap");
  assert.match(result.reason, /DEX router/);
});

test("Base proxy router tek yönlü receipt hareketini swap olarak sınıflandırır", () => {
  const result = classifyTransactionWithInspection("0xec5b999d", {
    targetAddress: "0x7251febeabb01ec9de53ece7a96f1c951f886dd2",
    nativeValue: 0,
    tokenMovements: [{ direction: "in" }],
  });

  assert.equal(result.activity, "swap");
});

test("likidite ve approval çağrılarını ayırır", () => {
  assert.equal(classifyTransaction("0xe8e337001234"), "liquidity_add");
  assert.equal(classifyTransaction("0x095ea7b31234"), "approval");
});
