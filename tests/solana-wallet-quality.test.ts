import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSolanaWalletHistory, calculateSolanaQualityEvidenceScore } from "../src/lib/solana/wallet-quality.ts";

const wallet = "8an4iWn8KV6z8Jdc4kp5SsAQ3WkQhV7YrAiiVhwVqbUe";
const pool = "u3boVk6xTdDdoWWfamHHGKbewR1gdZEUAwA5EtSSQZL";
const token = "4LjLUvg56sBrzstX6Cw9YYr3k31PdZGQg5u2mCM4pump";

test("Solana cüzdan geçmişinde kapanan round-trip ve gerçekleşen PnL hesaplanır", () => {
  const result = analyzeSolanaWalletHistory([
    {
      signature: "buy",
      timestamp: 1,
      feePayer: wallet,
      fee: 5_000,
      tokenTransfers: [{ mint: token, fromUserAccount: pool, toUserAccount: wallet, tokenAmount: 100 }],
      nativeTransfers: [{ fromUserAccount: wallet, toUserAccount: pool, amount: 1_000_000_000 }],
    },
    {
      signature: "sell",
      timestamp: 2,
      feePayer: wallet,
      fee: 5_000,
      tokenTransfers: [{ mint: token, fromUserAccount: wallet, toUserAccount: pool, tokenAmount: 100 }],
      nativeTransfers: [{ fromUserAccount: pool, toUserAccount: wallet, amount: 1_500_000_000 }],
    },
  ], wallet, 100);

  assert.equal(result.swapCount, 2);
  assert.equal(result.uniqueTokenCount, 1);
  assert.equal(result.completedRoundTrips, 1);
  assert.equal(result.profitableRoundTrips, 1);
  assert.equal(result.winRatePercent, 100);
  assert.ok(result.realizedPnlUsd > 49.9 && result.realizedPnlUsd < 50);
});

test("Başka fee payer cüzdanının havuz hareketleri kalite geçmişine eklenmez", () => {
  const result = analyzeSolanaWalletHistory([{
    signature: "other-wallet",
    feePayer: pool,
    tokenTransfers: [{ mint: token, fromUserAccount: pool, toUserAccount: wallet, tokenAmount: 100 }],
  }], wallet, 100);

  assert.equal(result.swapCount, 0);
});

test("Tekrarlanan kârlı ve çeşitli geçmiş yüksek kalite kanıtı üretir", () => {
  const score = calculateSolanaQualityEvidenceScore({
    swapCount: 46,
    buyCount: 36,
    sellCount: 10,
    uniqueTokenCount: 9,
    completedRoundTrips: 9,
    profitableRoundTrips: 5,
    winRatePercent: 55.56,
    realizedPnlUsd: 2_200,
    realizedCostUsd: 3_800,
    realizedPnlPercent: 57.9,
  });
  assert.ok(score >= 85);
});
