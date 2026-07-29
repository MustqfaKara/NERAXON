import assert from "node:assert/strict";
import test from "node:test";
import { hypercoreExternalCapitalFlowUsd } from "../src/lib/engine/hypercore-capital-flow.ts";

const account = "0x1111111111111111111111111111111111111111";

test("HyperCore dışarıdan gelen USDC transferini sermaye girişi sayar", () => {
  const flow = hypercoreExternalCapitalFlowUsd([{
    time: 200,
    hash: "incoming",
    delta: {
      type: "send",
      user: "0x2222222222222222222222222222222222222222",
      destination: account,
      usdcValue: "36.07",
    },
  }], account, 100);
  assert.equal(flow, 36.07);
});

test("para çekimini sermaye çıkışı, hesap içi aktarımı nötr sayar", () => {
  const flow = hypercoreExternalCapitalFlowUsd([
    { time: 200, hash: "withdraw", delta: { type: "withdraw", usdc: "5", fee: "1" } },
    { time: 300, hash: "internal", delta: { type: "accountClassTransfer", usdc: "10", toPerp: true } },
  ], account, 100);
  assert.equal(flow, -5);
});

test("baz çizgisinden eski hareketleri tekrar sermayeye eklemez", () => {
  const flow = hypercoreExternalCapitalFlowUsd([
    { time: 100, hash: "old", delta: { type: "deposit", usdc: "20" } },
    { time: 201, hash: "new", delta: { type: "deposit", usdc: "7" } },
  ], account, 200);
  assert.equal(flow, 7);
});
