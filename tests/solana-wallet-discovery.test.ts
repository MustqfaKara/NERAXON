import assert from "node:assert/strict";
import test from "node:test";
import { extractSolanaSwapMovement } from "../src/lib/solana/swap-movement.ts";
import { SOLANA_NATIVE_MINT } from "../src/lib/solana/constants.ts";
import { isSolanaDiscoveryWalletEligible, isSolanaTokenPerformanceEligible } from "../src/lib/engine/discovery-pnl.ts";

const wallet = "8an4iWn8KV6z8Jdc4kp5SsAQ3WkQhV7YrAiiVhwVqbUe";
const pool = "u3boVk6xTdDdoWWfamHHGKbewR1gdZEUAwA5EtSSQZL";
const token = "4LjLUvg56sBrzstX6Cw9YYr3k31PdZGQg5u2mCM4pump";

test("Solana token alımını fee payer ve gerçek SOL çıkışıyla hesaplar", () => {
  const movement = extractSolanaSwapMovement({
    signature: "buy",
    feePayer: wallet,
    tokenTransfers: [{ mint: token, fromUserAccount: pool, toUserAccount: wallet, tokenAmount: 10_000 }],
    nativeTransfers: [{ fromUserAccount: wallet, toUserAccount: pool, amount: 2_000_000_000 }],
  }, token, 150);

  assert.deepEqual(movement, { wallet, direction: "buy", tokenAmount: 10_000, notionalUsd: 300 });
});

test("Solana token satışını wrapped SOL girişiyle hesaplar", () => {
  const movement = extractSolanaSwapMovement({
    signature: "sell",
    feePayer: wallet,
    tokenTransfers: [
      { mint: token, fromUserAccount: wallet, toUserAccount: pool, tokenAmount: 2_500 },
      { mint: SOLANA_NATIVE_MINT, fromUserAccount: pool, toUserAccount: wallet, tokenAmount: 0.5 },
    ],
  }, token, 160);

  assert.deepEqual(movement, { wallet, direction: "sell", tokenAmount: 2_500, notionalUsd: 80 });
});

test("fee payer token hareketine katılmıyorsa havuz transferini cüzdan saymaz", () => {
  const movement = extractSolanaSwapMovement({
    signature: "pool-only",
    feePayer: wallet,
    tokenTransfers: [{ mint: token, fromUserAccount: pool, toUserAccount: "another-wallet", tokenAmount: 1_000 }],
  }, token, 150);

  assert.equal(movement, null);
});

test("Solana token katkılarını cüzdan toplamında birleştirmek için pozitif akışı kabul eder", () => {
  assert.equal(isSolanaTokenPerformanceEligible({
    boughtUsd: 75,
    estimatedPnlUsd: 20,
    swapCount: 2,
    buyCount: 1,
  }), true);
});

test("Solana tarafında toz veya zararlı token akışını adaya katmaz", () => {
  assert.equal(isSolanaTokenPerformanceEligible({
    boughtUsd: 20,
    estimatedPnlUsd: 10,
    swapCount: 2,
    buyCount: 1,
  }), false);
  assert.equal(isSolanaTokenPerformanceEligible({
    boughtUsd: 200,
    estimatedPnlUsd: -5,
    swapCount: 2,
    buyCount: 1,
  }), false);
});

test("Solana keşfi 100 USD kârla birlikte en az yüzde 100 net ROI ister", () => {
  const base = {
    boughtUsd: 200,
    soldUsd: 0,
    currentValueUsd: 230,
    estimatedPnlPercent: 15,
    swapCount: 2,
  };
  assert.equal(isSolanaDiscoveryWalletEligible({ ...base, estimatedPnlUsd: 100 }), false);
  assert.equal(isSolanaDiscoveryWalletEligible({ ...base, estimatedPnlUsd: 99 }), false);
  assert.equal(isSolanaDiscoveryWalletEligible({
    ...base,
    currentValueUsd: 400,
    estimatedPnlUsd: 200,
    estimatedPnlPercent: 100,
  }), true);
});
