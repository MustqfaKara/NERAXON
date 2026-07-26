import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTokenSafety } from "../src/lib/engine/token-security.ts";
import { mergeTokenSafety } from "../src/lib/engine/token-safety-merge.ts";

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

test("çoklu cüzdan teyitli yeni pump havuzunu uyarıyla kabul eder", () => {
  const result = evaluateTokenSafety(
    { ...market, pairCreatedAt: Date.now() - 5 * 60 * 1000 },
    { allowYoungPool: true },
  );
  assert.equal(result.approved, true);
  assert.match(result.reason, /çoklu cüzdan teyidi/i);
});

test("piyasa reddi kontrat uyarıları tarafından gizlenmez", () => {
  const base = evaluateTokenSafety({ ...market, liquidityUsd: 0 });
  const merged = mergeTokenSafety(base, {
    approved: true,
    warnings: ["Kontrat sahipliği aktif."],
    checks: [{ label: "Kontrat sahipliği", status: "warning", detail: "Aktif owner bulundu." }],
  });
  assert.equal(merged.approved, false);
  assert.equal(merged.reason, "Token havuzunda doğrulanabilir likidite bulunamadı.");
});
