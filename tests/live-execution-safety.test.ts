import assert from "node:assert/strict";
import test from "node:test";
import { evaluateJupiterShieldWarnings } from "../src/lib/security/solana-token-security.ts";
import { isHypercoreCrossMarginUnsupported, isJupiterSlippageError, nextJupiterSlippageBps } from "../src/lib/execution/live-error-policy.ts";
import { isRecoverableRpcMonitoringError } from "../src/lib/chains/runtime-error-policy.ts";

test("Jupiter Shield freeze authority uyarısını Solana alımı için engeller", () => {
  const result = evaluateJupiterShieldWarnings([{
    type: "HAS_FREEZE_AUTHORITY",
    message: "Token hesapları dondurulabilir.",
    severity: "warning",
  }]);

  assert.equal(result.approved, false);
  assert.equal(result.checks[0]?.status, "failed");
});

test("Jupiter Shield bilgi uyarıları görünür kalır ancak tek başına alımı engellemez", () => {
  const result = evaluateJupiterShieldWarnings([{
    type: "LOW_ORGANIC_ACTIVITY",
    message: "Organik aktivite düşük.",
    severity: "info",
  }]);

  assert.equal(result.approved, true);
  assert.equal(result.checks[0]?.status, "warning");
  assert.deepEqual(result.warnings, []);
});

test("Jupiter slippage hatası tanınır ve yeniden deneme risk tavanında kalır", () => {
  assert.equal(isJupiterSlippageError(new Error("custom program error: 0x1771")), true);
  assert.equal(isJupiterSlippageError(new Error("insufficient funds")), false);
  assert.equal(nextJupiterSlippageBps(75, 300), 125);
  assert.equal(nextJupiterSlippageBps(275, 300), 300);
  assert.equal(nextJupiterSlippageBps(300, 300), 300);
});

test("HyperCore yalnızca izole marj isteyen piyasa hatasını ayırt eder", () => {
  assert.equal(isHypercoreCrossMarginUnsupported(new Error("Cross margin is not allowed for this asset.")), true);
  assert.equal(isHypercoreCrossMarginUnsupported(new Error("Insufficient margin")), false);
});

test("geçici RPC sağlayıcı hataları izleyiciyi kalıcı durdurmaz", () => {
  assert.equal(isRecoverableRpcMonitoringError(new Error("Monthly capacity limit exceeded")), true);
  assert.equal(isRecoverableRpcMonitoringError(new Error("context deadline exceeded")), true);
  assert.equal(isRecoverableRpcMonitoringError(new Error("Geçersiz zincir yapılandırması")), false);
});
