import assert from "node:assert/strict";
import test from "node:test";
import { availableHypercoreSpotUsdc, effectiveHypercoreCollateralUsd, requiredPerpTransferAmount } from "../src/lib/execution/hypercore-collateral.ts";

test("yeterli perp teminatında spot transferi yapmaz", () => {
  assert.equal(requiredPerpTransferAmount(12, 20, 10.5), 0);
});

test("perp açığını küçük bir tamponla spot bakiyeden tamamlar", () => {
  assert.equal(requiredPerpTransferAmount(0, 20.94, 10.5), 11);
});

test("spot ve perp toplamı minimumu karşılamıyorsa reddeder", () => {
  assert.throws(() => requiredPerpTransferAmount(2, 8, 10.5), /yetersiz/);
});

test("unified hesapta spot USDC doğrudan perp teminatına eklenir", () => {
  assert.equal(effectiveHypercoreCollateralUsd("unifiedAccount", 0, 20.32), 20.32);
  assert.equal(effectiveHypercoreCollateralUsd("unifiedAccount", 5, 20.32), 20.32);
  assert.equal(effectiveHypercoreCollateralUsd("default", 4, 20.32), 4);
});

test("unified hesap kullanılabilir USDC için maintenance sonrası değeri kullanır", () => {
  assert.equal(availableHypercoreSpotUsdc({
    abstraction: "unifiedAccount",
    totalUsd: 20.22779298,
    holdUsd: 14.8868,
    availableAfterMaintenanceUsd: 20.07892498,
  }), 20.07892498);
  assert.equal(availableHypercoreSpotUsdc({
    abstraction: "default",
    totalUsd: 20.22779298,
    holdUsd: 14.8868,
    availableAfterMaintenanceUsd: 20.07892498,
  }).toFixed(6), "5.340993");
});
