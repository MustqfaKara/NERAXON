import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTokenSafety } from "../src/lib/engine/token-security.ts";
import { mergeTokenSafety } from "../src/lib/engine/token-safety-merge.ts";
import { evaluateHoneypotReport } from "../src/lib/security/honeypot-security.ts";

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

test("çift yönlü Robinhood Portal rotasını AMM havuzu olmadan kontrollü kabul eder", () => {
  const result = evaluateTokenSafety({
    chainId: "robinhood",
    tokenAddress: "0x0000000000000000000000000000000000000001",
    tokenSymbol: "PORTAL",
    priceUsd: 0.01,
    liquidityUsd: 0,
    volume24hUsd: 0,
    priceChange24hPercent: 0,
    marketCapUsd: 100_000,
    fdvUsd: 100_000,
    pairAddress: "0x65050A9b7E5075A2bA5cED7b1b64EE66262c40Dc",
    dexId: "robinhood-portal",
    pairCreatedAt: Date.now(),
    fetchedAt: new Date().toISOString(),
    marketKind: "robinhood-portal",
    exitRouteVerified: true,
  });

  assert.equal(result.approved, true);
  assert.ok(result.warnings.some((warning) => warning.includes("Portal")));
});

test("satış rotası doğrulanmayan Robinhood Portal varlığını reddeder", () => {
  const result = evaluateTokenSafety({
    chainId: "robinhood",
    tokenAddress: "0x0000000000000000000000000000000000000001",
    tokenSymbol: "PORTAL",
    priceUsd: 0.01,
    liquidityUsd: 0,
    volume24hUsd: 0,
    priceChange24hPercent: 0,
    marketCapUsd: 100_000,
    fdvUsd: 100_000,
    pairAddress: "0x65050A9b7E5075A2bA5cED7b1b64EE66262c40Dc",
    dexId: "robinhood-portal",
    pairCreatedAt: Date.now(),
    fetchedAt: new Date().toISOString(),
    marketKind: "robinhood-portal",
    exitRouteVerified: false,
  });

  assert.equal(result.approved, false);
  assert.match(result.reason, /satış rotası/);
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

test("honeypot veya yüksek riskli token alımını reddeder", () => {
  const result = evaluateHoneypotReport({
    summary: { risk: "honeypot", riskLevel: 100, flags: [{ flag: "medium_fail_rate", severity: "high", description: "Birçok kullanıcı satış yapamıyor." }] },
    simulationSuccess: true,
    honeypotResult: { isHoneypot: true, honeypotReason: "HONEYPOT DETECTED" },
  });
  assert.equal(result.approved, false);
  assert.match(result.checks[0].detail, /HONEYPOT DETECTED/);
});

test("başarılı bağımsız alım ve satış simülasyonunu kabul eder", () => {
  const result = evaluateHoneypotReport({
    summary: { risk: "low", riskLevel: 8, flags: [] },
    simulationSuccess: true,
    honeypotResult: { isHoneypot: false },
    simulationResult: { sellTax: 2 },
    contractCode: { rootOpenSource: true },
  });
  assert.equal(result.approved, true);
  assert.equal(result.checks[0].status, "passed");
});

test("belirsiz satış simülasyonunda güvenli tarafta kalır", () => {
  const result = evaluateHoneypotReport({
    summary: { risk: "unknown", riskLevel: 0 },
    simulationSuccess: false,
    simulationError: "Pair simulation failed",
  });
  assert.equal(result.approved, false);
  assert.match(result.checks[0].detail, /simulation failed/i);
});
