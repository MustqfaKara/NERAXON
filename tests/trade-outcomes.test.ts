import test from "node:test";
import assert from "node:assert/strict";
import type { Trade } from "../src/lib/domain/types.ts";
import { deriveTradeOutcomes } from "../src/lib/engine/trade-outcomes.ts";

const fees = { dexFeeUsd: 0, gasFeeUsd: 0, slippageUsd: 0, priceImpactUsd: 0, tokenTaxUsd: 0, totalUsd: 0 };
const trade = (update: Partial<Trade>): Trade => ({
  id: crypto.randomUUID(), chainId: "ethereum", walletId: "wallet-a", source: "copy", side: "buy",
  tokenAddress: "0x0000000000000000000000000000000000000001", tokenSymbol: "TEST", quantity: 10,
  priceUsd: 1, grossUsd: 10, netUsd: 10, realizedPnlUsd: 0, executionDelayMs: 0,
  status: "confirmed", fees, reason: "test", txHash: null, createdAt: "2026-01-01T00:00:00.000Z", ...update,
});

test("eski kayıtlarda alan sıfır olsa da FIFO satış PnL değerini üretir", () => {
  const result = deriveTradeOutcomes([
    trade({ id: "buy", side: "buy", quantity: 10, netUsd: 10 }),
    trade({ id: "sell", side: "sell", quantity: 5, netUsd: 7, createdAt: "2026-01-01T00:01:00.000Z" }),
  ]);
  assert.equal(result[1].hasRealizedOutcome, true);
  assert.equal(result[1].derivedRealizedPnlUsd, 2);
});

test("kopya satış başka cüzdanın lotunu tüketmez", () => {
  const result = deriveTradeOutcomes([
    trade({ id: "buy", walletId: "wallet-a" }),
    trade({ id: "sell", walletId: "wallet-b", side: "sell", quantity: 10, netUsd: 12, createdAt: "2026-01-01T00:01:00.000Z" }),
  ]);
  assert.equal(result[1].hasRealizedOutcome, false);
  assert.equal(result[1].derivedRealizedPnlUsd, 0);
});
