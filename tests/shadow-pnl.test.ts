import test from "node:test";
import assert from "node:assert/strict";
import { calculateShadowPnl } from "../src/lib/engine/shadow-pnl.ts";

test("funding token fiyat hareketini unrealized PnL içine alır", () => {
  const result = calculateShadowPnl({
    startingEquityUsd: 33.33,
    equityUsd: 34.114473,
    realizedPnlUsd: -0.025544,
    positionValueUsd: 8.432137,
    remainingPositionCostUsd: 8.085043,
  });

  assert.ok(Math.abs(result.positionUnrealizedPnlUsd - 0.347094) < 1e-9);
  assert.ok(Math.abs(result.fundingTokenPnlUsd - 0.462923) < 1e-6);
  assert.ok(Math.abs(-0.025544 + result.unrealizedPnlUsd - (34.114473 - 33.33)) < 1e-9);
});
