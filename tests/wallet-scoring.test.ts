import test from "node:test";
import assert from "node:assert/strict";
import { calculateWalletScore } from "../src/lib/engine/wallet-scoring.ts";

test("verisiz cüzdanı nötr gözlem skoruyla başlatır", () => {
  assert.equal(calculateWalletScore().score, 50);
});

test("istikrarlı ve kopyalanabilir cüzdana yüksek skor verir", () => {
  const result = calculateWalletScore({
    totalTrades: 50,
    winRate: 0.72,
    realizedPnlPercent: 24,
    maxDrawdownPercent: 8,
    copyableTradeRatio: 0.9,
    lowLiquidityTradeRatio: 0.05,
    suspiciousActivityRatio: 0,
  });
  assert.ok(result.score >= 75);
});
