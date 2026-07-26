import assert from "node:assert/strict";
import test from "node:test";
import { calculateSolanaFallbackScore } from "../src/lib/engine/solana-fallback-quality.ts";

const strongCandidate = {
  candidateScore: 82,
  estimatedPnlUsd: 420,
  estimatedPnlPercent: 38,
  swapCount24h: 12,
  historySwapCount: 8,
  historySellCount: 2,
  completedRoundTrips: 0,
};

test("güçlü güncel kanıtı olan Solana cüzdanını geçici skorla korur", () => {
  const score = calculateSolanaFallbackScore(strongCandidate);
  assert.ok(score !== null && score >= 58 && score <= 72);
});

test("düşük kâr, aşırı ROI ve yoğun aktiviteyi geçici aday yapmaz", () => {
  assert.equal(calculateSolanaFallbackScore({ ...strongCandidate, estimatedPnlUsd: 99 }), null);
  assert.equal(calculateSolanaFallbackScore({ ...strongCandidate, estimatedPnlPercent: 501 }), null);
  assert.equal(calculateSolanaFallbackScore({ ...strongCandidate, swapCount24h: 51 }), null);
});

test("tam kapanış kanıtı olan cüzdanı geçici algoritmaya sokmaz", () => {
  assert.equal(calculateSolanaFallbackScore({ ...strongCandidate, completedRoundTrips: 1 }), null);
});

test("tek yönlü al-tut davranışında genel skor düşük olsa da finansal kanıtı korur", () => {
  const score = calculateSolanaFallbackScore({
    ...strongCandidate,
    candidateScore: 48,
    historySellCount: 0,
  });
  assert.ok(score !== null && score >= 58);
});
