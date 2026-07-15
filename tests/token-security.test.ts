import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTokenSafety } from "../src/lib/engine/token-security.ts";

const market = {
  chainId: "base" as const,
  tokenAddress: "0x0000000000000000000000000000000000000001",
  tokenSymbol: "TEST",
  priceUsd: 1,
  liquidityUsd: 100_000,
  volume24hUsd: 20_000,
  priceChange24hPercent: 12,
  marketCapUsd: 750_000,
  fdvUsd: 1_000_000,
  pairAddress: "0x0000000000000000000000000000000000000002",
  dexId: "aerodrome",
  pairCreatedAt: Date.now() - 48 * 60 * 60 * 1000,
  fetchedAt: new Date().toISOString(),
};

test("yeterli geçmişi ve likiditesi olan havuzu onaylar", () => {
  assert.equal(evaluateTokenSafety(market).approved, true);
});

test("otuz dakikadan yeni havuzu reddeder", () => {
  const result = evaluateTokenSafety({ ...market, pairCreatedAt: Date.now() - 5 * 60 * 1000 });
  assert.equal(result.approved, false);
  assert.match(result.reason, /30 dakikadan yeni/);
});
