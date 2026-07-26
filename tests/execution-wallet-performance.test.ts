import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionLot } from "../src/lib/domain/types.ts";
import { executionLotNetPnl } from "../src/lib/engine/execution-wallet-performance.ts";

const lot: ExecutionLot = {
  id: "lot", integrationId: "base", mode: "shadow", assetKey: "token", walletId: "wallet", source: "copy", marketType: "evm", positionSide: null,
  amount: "5000000", initialAmount: "10000000", amountFormat: "base_units", assetSymbol: "TOKEN", assetDecimals: 6,
  entryPriceUsd: 2, currentPriceUsd: 3, entryCostUsd: 20, realizedPnlUsd: 2, feesUsd: 0.1, leverage: 1, entryReference: null,
  status: "open", openedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

test("açık execution lotu gerçekleşen ve güncel PnL ile hesaplanır", () => {
  assert.equal(executionLotNetPnl(lot), 7);
});

test("kapalı lotta kayıtlı gerçekleşen PnL kullanılır", () => {
  assert.equal(executionLotNetPnl({ ...lot, status: "closed", realizedPnlUsd: -1.25 }), -1.25);
});

test("kapalı perp lotunda giriş ücreti net sonuçtan düşülür", () => {
  const closedPerp = {
    ...lot,
    marketType: "perp" as const,
    positionSide: "long" as const,
    amount: "0",
    initialAmount: "2",
    amountFormat: "decimal" as const,
    entryPriceUsd: 10,
    entryCostUsd: 10.2,
    leverage: 2,
    status: "closed" as const,
    realizedPnlUsd: 1.9,
  };

  assert.ok(Math.abs(executionLotNetPnl(closedPerp) - 1.7) < 1e-9);
});

test("kısmen kapanan perp lotunda çıkış ücretini ikinci kez düşmez", () => {
  const perpLot: ExecutionLot = {
    ...lot,
    marketType: "perp",
    positionSide: "long",
    amountFormat: "decimal",
    amount: "0.5",
    initialAmount: "1",
    assetDecimals: 0,
    entryPriceUsd: 20,
    currentPriceUsd: 24,
    entryCostUsd: 10.2,
    realizedPnlUsd: 1.9,
    feesUsd: 0.3,
    leverage: 2,
  };

  assert.ok(Math.abs(executionLotNetPnl(perpLot) - 3.7) < 1e-9);
});
