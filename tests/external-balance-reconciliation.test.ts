import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionLot } from "../src/lib/domain/types.ts";
import { planExternalBalanceAdjustment } from "../src/lib/engine/external-balance-reconciliation.ts";

function lot(overrides: Partial<ExecutionLot> = {}): ExecutionLot {
  return {
    id: "lot-1",
    integrationId: "base",
    mode: "live",
    assetKey: "0x0000000000000000000000000000000000000001",
    walletId: "wallet-1",
    source: "copy",
    marketType: "evm",
    positionSide: null,
    amount: "10000000000000000000",
    initialAmount: "10000000000000000000",
    amountFormat: "base_units",
    assetSymbol: "TEST",
    pairAddress: null,
    assetDecimals: 18,
    entryPriceUsd: 1,
    currentPriceUsd: 1.5,
    entryCostUsd: 10,
    realizedPnlUsd: 0,
    feesUsd: 0,
    leverage: 1,
    entryReference: null,
    status: "open",
    openedAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  };
}

test("zincir bakiyesi sıfırsa açık lotun tamamını harici satış olarak planlar", () => {
  const adjustment = planExternalBalanceAdjustment([lot()], 0n);
  assert.ok(adjustment);
  assert.equal(adjustment.reductionAmount, 10_000_000_000_000_000_000n);
  assert.equal(adjustment.estimatedNetProceedsUsd, 15);
  assert.equal(adjustment.estimatedCostBasisUsd, 10);
  assert.equal(adjustment.estimatedRealizedPnlUsd, 5);
});

test("kısmi manuel satışta yalnızca zincir ve yerel bakiye farkını azaltır", () => {
  const adjustment = planExternalBalanceAdjustment([lot()], 4_000_000_000_000_000_000n);
  assert.ok(adjustment);
  assert.equal(adjustment.reductionAmount, 6_000_000_000_000_000_000n);
  assert.equal(adjustment.estimatedNetProceedsUsd, 9);
  assert.equal(adjustment.estimatedCostBasisUsd, 6);
});

test("zincir bakiyesi yerel lotu karşılıyorsa değişiklik üretmez", () => {
  assert.equal(planExternalBalanceAdjustment([lot()], 10_000_000_000_000_000_000n), null);
});

test("fiyatı olmayan harici satış muhasebe tahminini güvenilmez olarak işaretler", () => {
  const adjustment = planExternalBalanceAdjustment([lot({ currentPriceUsd: 0 })], 0n);
  assert.ok(adjustment);
  assert.equal(adjustment.hasMarketPrice, false);
  assert.equal(adjustment.estimatedNetProceedsUsd, 0);
});
