import test from "node:test";
import assert from "node:assert/strict";
import { calculateSolanaSmartWalletScore, isSolanaSmartWalletEligible, solanaSmartWalletRejectionReasons, type SolanaSmartWalletMetrics } from "../src/lib/engine/solana-smart-wallet-score.ts";

const strongWallet: SolanaSmartWalletMetrics = {
  trades24h: 12,
  buys24h: 6,
  invested24hUsd: 4_800,
  invested7dUsd: 18_000,
  uniqueTokens7d: 9,
  closedTokens7d: 7,
  winRate7d: 71,
  realizedPnl7dUsd: 2_400,
  realizedRoi7dPercent: 38,
  unrealizedPnl7dUsd: -120,
  totalPnl7dUsd: 2_280,
  averageBuyUsd: 800,
  suspiciousTagCount: 0,
};

test("istikrarlı ve ölçülü Solana cüzdanı keşfe kabul edilir", () => {
  assert.equal(isSolanaSmartWalletEligible(strongWallet), true);
  assert.ok(calculateSolanaSmartWalletScore(strongWallet).score >= 80);
});

test("aşırı ROI, yoğun işlem ve şüpheli etiket reddedilir", () => {
  assert.equal(isSolanaSmartWalletEligible({ ...strongWallet, realizedRoi7dPercent: 800 }), false);
  assert.equal(isSolanaSmartWalletEligible({ ...strongWallet, trades24h: 51 }), false);
  assert.equal(isSolanaSmartWalletEligible({ ...strongWallet, suspiciousTagCount: 1 }), false);
});

test("24 saatte 50 swap sınırda kabul edilir", () => {
  assert.equal(isSolanaSmartWalletEligible({ ...strongWallet, trades24h: 50 }), true);
});

test("açık zararı gerçekleşmiş kârı silen cüzdan reddedilir", () => {
  assert.equal(isSolanaSmartWalletEligible({ ...strongWallet, unrealizedPnl7dUsd: -1_100, totalPnl7dUsd: 1_300 }), false);
  assert.ok(solanaSmartWalletRejectionReasons({ ...strongWallet, unrealizedPnl7dUsd: -1_100 }).includes("open_drawdown"));
});

test("iki kapanış ve yüzde 50 kazanma oranı geniş keşif örneklemine kabul edilir", () => {
  const expandedSample = { ...strongWallet, uniqueTokens7d: 2, closedTokens7d: 2, winRate7d: 50 };
  assert.equal(isSolanaSmartWalletEligible(expandedSample), true);
  assert.ok(calculateSolanaSmartWalletScore(expandedSample).score >= 65);
});

test("kâr eşiği ve şüpheli cüzdan engeli geniş örneklemde korunur", () => {
  assert.equal(isSolanaSmartWalletEligible({ ...strongWallet, realizedPnl7dUsd: 99 }), false);
  assert.equal(isSolanaSmartWalletEligible({ ...strongWallet, totalPnl7dUsd: 99 }), false);
  assert.equal(isSolanaSmartWalletEligible({ ...strongWallet, suspiciousTagCount: 1 }), false);
});
