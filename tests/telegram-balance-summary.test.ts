import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionLot } from "../src/lib/domain/types.ts";
import { summarizeOpenPositionBalances } from "../src/lib/telegram/balance-summary.ts";

function lot(overrides: Partial<ExecutionLot>): ExecutionLot {
  return {
    id: crypto.randomUUID(),
    integrationId: "hyperliquid",
    mode: "live",
    assetKey: "perp:eth",
    walletId: null,
    source: "copy",
    marketType: "perp",
    positionSide: "long",
    amount: "0.0054",
    initialAmount: "0.0054",
    amountFormat: "decimal",
    assetSymbol: "ETH",
    pairAddress: null,
    assetDecimals: 0,
    entryPriceUsd: 1_953.9,
    currentPriceUsd: 1_906.13,
    entryCostUsd: 5.280088,
    realizedPnlUsd: 0,
    feesUsd: 0.004558,
    leverage: 2,
    entryReference: null,
    status: "open",
    openedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("HyperCore teminatını piyasa maruziyetinden ayrı hesaplar", () => {
  const result = summarizeOpenPositionBalances([
    lot({}),
    lot({
      assetKey: "perp:bnb",
      assetSymbol: "BNB",
      amount: "0.035",
      initialAmount: "0.035",
      currentPriceUsd: 569.62,
      entryCostUsd: 6.645651,
      leverage: 3,
      positionSide: "short",
    }),
  ]);

  assert.equal(result.allocatedCapitalUsd.toFixed(2), "11.93");
  assert.equal(result.marketExposureUsd.toFixed(2), "30.23");
  assert.equal(result.positionCount, 2);
});

test("kapalı lotları bakiye özetine katmaz", () => {
  const result = summarizeOpenPositionBalances([lot({ status: "closed" })]);
  assert.deepEqual(result, {
    allocatedCapitalUsd: 0,
    marketExposureUsd: 0,
    positionCount: 0,
  });
});
