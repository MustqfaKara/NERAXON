import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionAttempt } from "../src/lib/domain/types.ts";
import { calculateExecutionQuality } from "../src/lib/engine/execution-quality.ts";
import { isPreExecutionFilter } from "../src/lib/engine/execution-outcome.ts";

const attempt = (status: ExecutionAttempt["status"]): ExecutionAttempt => ({
  id: status, requestId: status, idempotencyKey: status, integrationId: "base", walletId: "wallet-1", mode: "shadow", source: "copy", action: "buy", asset: "TOKEN", status,
  amountIn: null, amountOut: null, expectedAmountOut: null, minimumAmountOut: null, quotedPriceUsd: 0, slippagePercent: 0, priceImpactPercent: 0,
  networkFeeUsd: 0, dexFeeUsd: 0, availableBalanceUsd: 0, simulationLatencyMs: 0, txHash: null, externalOrderId: null,
  accountingStatus: "pending", reconciliationStatus: "pending", reconciliationDetails: null, submittedAt: null, confirmedAt: null,
  accountedAt: null, reconciledAt: null, errorMessage: null, metadata: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
});

test("ön filtreler yürütme başarı oranının paydasına girmez", () => {
  const quality = calculateExecutionQuality([attempt("simulated"), attempt("simulated"), attempt("failed"), attempt("filtered")], "shadow");
  assert.equal(quality.executableAttempts, 3);
  assert.equal(quality.filteredBeforeExecution, 1);
  assert.equal(quality.successRate, 66.67);
});

test("rota ve likidite reddi ön filtre olarak sınıflandırılır", () => {
  assert.equal(isPreExecutionFilter("0x rotasında likidite bulunamadı."), true);
  assert.equal(isPreExecutionFilter("Token likiditesi kalite eşiğinin altında."), true);
  assert.equal(isPreExecutionFilter("Shadow token maruziyet sınırı aşılacak."), true);
  assert.equal(isPreExecutionFilter("base quote fiyat sapması %647 ile sınırı aşıyor."), true);
  assert.equal(isPreExecutionFilter("HyperCore minimum tick emri 14.99 USD ile 12.00 USD işlem tavanını aşıyor."), true);
  assert.equal(isPreExecutionFilter("base canlı açık pozisyon sınırına ulaştı."), true);
  assert.equal(isPreExecutionFilter("Token için doğrulanabilir Robinhood Uniswap v4 ETH havuzu bulunamadı."), true);
  assert.equal(isPreExecutionFilter("Hooks kullanan Robinhood havuzları canlı işlem için henüz izinli değil."), true);
  assert.equal(isPreExecutionFilter("Tahmini toplam fee %10 ile sınırını aşıyor."), true);
  assert.equal(isPreExecutionFilter("solana günlük canlı zarar oranı %10.92 ile %10 sınırına ulaştı."), true);
  assert.equal(isPreExecutionFilter("quoteExactInputSingle reverted."), true);
  assert.equal(isPreExecutionFilter("RPC timeout"), false);
});
