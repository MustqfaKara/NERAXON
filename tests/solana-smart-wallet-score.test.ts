import test from "node:test";
import assert from "node:assert/strict";
import { calculateSolanaSmartWalletScore, isSolanaSmartWalletEligible, type SolanaSmartWalletMetrics } from "../src/lib/engine/solana-smart-wallet-score.ts";

const strongWallet: SolanaSmartWalletMetrics = {
  trades24h: 12,
  buys24h: 6,
  invested24hUsd: 4_800,
  invested7dUsd: 1_800,
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
  assert.equal(isSolanaSmartWalletEligible({ ...strongWallet, realizedRoi7dPercent: 1_200 }), false);
  assert.equal(isSolanaSmartWalletEligible({ ...strongWallet, trades24h: 51 }), false);
  assert.equal(isSolanaSmartWalletEligible({ ...strongWallet, suspiciousTagCount: 1 }), false);
});

test("24 saatte 50 swap sınırda kabul edilir", () => {
  assert.equal(isSolanaSmartWalletEligible({ ...strongWallet, trades24h: 50 }), true);
});

test("açık düşüş sert filtre yerine risk skorunu azaltır", () => {
  const openDrawdown = {
    ...strongWallet,
    invested7dUsd: 150,
    unrealizedPnl7dUsd: -2_000,
    totalPnl7dUsd: 180,
  };
  assert.equal(isSolanaSmartWalletEligible(openDrawdown), true);
  assert.ok(
    calculateSolanaSmartWalletScore(openDrawdown).score
    < calculateSolanaSmartWalletScore(strongWallet).score,
  );
});

test("iki kapanış ve yüzde 50 kazanma oranı geniş keşif örneklemine kabul edilir", () => {
  const expandedSample = { ...strongWallet, uniqueTokens7d: 2, closedTokens7d: 2, winRate7d: 50 };
  assert.equal(isSolanaSmartWalletEligible(expandedSample), true);
  assert.ok(calculateSolanaSmartWalletScore(expandedSample).score >= 65);
});

test("kâr eşiği ve şüpheli cüzdan engeli geniş örneklemde korunur", () => {
  assert.equal(isSolanaSmartWalletEligible({ ...strongWallet, totalPnl7dUsd: 99 }), false);
  assert.equal(isSolanaSmartWalletEligible({ ...strongWallet, suspiciousTagCount: 1 }), false);
});

test("gerçekleşmemiş kârı güçlü ve geçmişi yeterli cüzdan skorla değerlendirilir", () => {
  const openWinner = {
    ...strongWallet,
    invested7dUsd: 300,
    winRate7d: 45,
    realizedPnl7dUsd: 40,
    unrealizedPnl7dUsd: 310,
    totalPnl7dUsd: 350,
    realizedRoi7dPercent: 4,
  };
  assert.equal(isSolanaSmartWalletEligible(openWinner), true);
  assert.ok(calculateSolanaSmartWalletScore(openWinner).score >= 60);
});

test("tek kapanışlı veya düşük kazanma oranlı cüzdan doğrudan silinmez", () => {
  const limitedEvidence = {
    ...strongWallet,
    uniqueTokens7d: 1,
    closedTokens7d: 1,
    winRate7d: 35,
  };
  assert.equal(isSolanaSmartWalletEligible(limitedEvidence), true);
  assert.ok(
    calculateSolanaSmartWalletScore(limitedEvidence).score
    < calculateSolanaSmartWalletScore(strongWallet).score,
  );
});

test("yüksek sermayeyle düşük oransal kâr eden cüzdan reddedilir", () => {
  const lowMultiple = {
    ...strongWallet,
    invested7dUsd: 10_000,
    totalPnl7dUsd: 2_500,
  };
  assert.equal(isSolanaSmartWalletEligible(lowMultiple), false);
});
