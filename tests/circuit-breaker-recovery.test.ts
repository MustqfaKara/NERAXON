import assert from "node:assert/strict";
import test from "node:test";
import type { CircuitBreakerState, ReconciliationRecord } from "../src/lib/domain/types.ts";
import { isRecoverableReconciliationHalt } from "../src/lib/engine/circuit-breaker-recovery.ts";

const halted: CircuitBreakerState = {
  halted: true,
  reason: "robinhood canlı mutabakatı başarısız: Yerel lot muhasebesi uygulanmadı.",
  consecutiveFailures: 0,
  triggeredAt: "2026-07-27T06:28:37.622Z",
  updatedAt: "2026-07-27T06:28:37.622Z",
};

function record(overrides: Partial<ReconciliationRecord> = {}): ReconciliationRecord {
  return {
    integrationId: "robinhood",
    status: "passed",
    details: "Zincir bakiyesi yerel live lotlarını karşılıyor.",
    checkedAt: "2026-07-29T10:19:50.866Z",
    ...overrides,
  };
}

test("daha yeni başarılı ağ mutabakatı eski canlı mutabakat kilidini kaldırabilir", () => {
  assert.equal(isRecoverableReconciliationHalt(halted, [record()]), true);
});

test("başarısız veya eski mutabakat canlı işlem kilidini kaldırmaz", () => {
  assert.equal(isRecoverableReconciliationHalt(halted, [record({ status: "failed" })]), false);
  assert.equal(isRecoverableReconciliationHalt(halted, [record({ checkedAt: "2026-07-27T06:00:00.000Z" })]), false);
});

test("manuel ve operasyonel durdurmalar mutabakat sonucu ile kaldırılmaz", () => {
  assert.equal(isRecoverableReconciliationHalt({
    ...halted,
    reason: "Web panelinden acil durdurma etkinleştirildi.",
  }, [record()]), false);
});
