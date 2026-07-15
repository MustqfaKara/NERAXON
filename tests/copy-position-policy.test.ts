import test from "node:test";
import assert from "node:assert/strict";
import type { Position } from "../src/lib/domain/types.ts";
import { getCopyPositionConflict } from "../src/lib/engine/copy-position-policy.ts";

const position: Position = {
  id: "position-1",
  chainId: "ethereum",
  tokenAddress: "0x1111111111111111111111111111111111111111",
  tokenSymbol: "TOKEN",
  sourceWalletId: "wallet-a",
  sourceWalletLabel: "A cüzdanı",
  quantity: 10,
  averageEntryUsd: 1,
  currentPriceUsd: 1,
  investedUsd: 10,
  unrealizedPnlUsd: 0,
  updatedAt: new Date(0).toISOString(),
};

test("aynı kaynak cüzdanın ek alım ve satışına izin verir", () => {
  assert.equal(getCopyPositionConflict(position, "wallet-a", "A cüzdanı", "buy"), null);
  assert.equal(getCopyPositionConflict(position, "wallet-a", "A cüzdanı", "sell"), null);
});

test("farklı cüzdanın aynı token alımını atlar", () => {
  assert.match(getCopyPositionConflict(position, "wallet-b", "B cüzdanı", "buy") ?? "", /tekrar kopyalanmadı/);
});

test("konsensüs eşiği oluştuğunda farklı cüzdanın ek alımına izin verir", () => {
  assert.equal(getCopyPositionConflict(position, "wallet-c", "C cüzdanı", "buy", { allowConsensusBuy: true }), null);
});

test("konsensüs alımı manuel pozisyona eklenmez", () => {
  const manualPosition = { ...position, sourceWalletId: null, sourceWalletLabel: null };
  assert.match(getCopyPositionConflict(manualPosition, "wallet-c", "C cüzdanı", "buy", { allowConsensusBuy: true }) ?? "", /tekrar kopyalanmadı/);
});

test("farklı cüzdanın satışını uygulamaz", () => {
  assert.match(getCopyPositionConflict(position, "wallet-b", "B cüzdanı", "sell") ?? "", /kaynak cüzdanın satışı beklenecek/);
});
