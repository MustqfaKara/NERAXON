import assert from "node:assert/strict";
import test from "node:test";
import { calculateHypercoreAccountValues } from "../src/lib/engine/hypercore-live-accounting.ts";

test("unified HyperCore hesabında spot toplamına yansımış perp PnL ikinci kez uygulanmaz", () => {
  const result = calculateHypercoreAccountValues({
    unified: true,
    spotBalances: [
      { coin: "USDC", total: 20.22779298, hold: 14.8868 },
      { coin: "HYPE", total: 0.00987905, hold: 0 },
    ],
    spotPricesUsd: { HYPE: 59 },
    availableUsdcAfterMaintenance: 20.07892498,
    perpStates: [
      { accountValueUsd: 0, withdrawableUsd: 0, unrealizedPnlUsd: 0 },
      { accountValueUsd: 14.884043, withdrawableUsd: 0.000043, unrealizedPnlUsd: -0.0366 },
    ],
  });

  assert.equal(result.cashBalanceUsd.toFixed(6), "20.078925");
  assert.equal(result.equityUsd.toFixed(6), "20.810657");
  assert.equal(result.positionValueUsd.toFixed(6), "0.731732");
  assert.equal(result.perpUnrealizedPnlUsd, -0.0366);
});

test("klasik HyperCore hesabında ayrı perp hesap değeri özsermayeye eklenir", () => {
  const result = calculateHypercoreAccountValues({
    unified: false,
    spotBalances: [{ coin: "USDC", total: 5, hold: 0 }],
    spotPricesUsd: {},
    perpStates: [{ accountValueUsd: 10, withdrawableUsd: 4, unrealizedPnlUsd: -1 }],
  });

  assert.equal(result.equityUsd, 15);
  assert.equal(result.cashBalanceUsd, 9);
  assert.equal(result.positionValueUsd, 6);
});
