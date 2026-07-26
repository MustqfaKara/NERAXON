import assert from "node:assert/strict";
import test from "node:test";
import { calculateSolanaBuyTransactionCosts, estimateSolanaNetworkFeeLamports } from "../src/lib/execution/solana-fee.ts";

test("Solana tahmini ağ ücreti temel imza ücretini içerir", () => {
  assert.equal(estimateSolanaNetworkFeeLamports(81_629), 86_629);
});

test("Solana alımında iade edilebilir hesap kirası fee'den ayrılır", () => {
  const result = calculateSolanaBuyTransactionCosts({
    preBalanceLamports: 118_466_665n,
    postBalanceLamports: 108_076_263n,
    swapInputLamports: 8_229_693n,
    networkFeeLamports: 86_629n,
  });

  assert.equal(result.networkFeeLamports, 86_629n);
  assert.equal(result.refundableRentLamports, 2_074_080n);
});

test("negatif fark yanlışlıkla kira olarak raporlanmaz", () => {
  const result = calculateSolanaBuyTransactionCosts({
    preBalanceLamports: 10_000_000n,
    postBalanceLamports: 9_000_000n,
    swapInputLamports: 995_000n,
    networkFeeLamports: 10_000n,
  });

  assert.equal(result.refundableRentLamports, 0n);
});
