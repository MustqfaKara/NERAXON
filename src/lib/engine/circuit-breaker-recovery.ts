import type { CircuitBreakerState, ReconciliationRecord } from "@/lib/domain/types";

export function isRecoverableReconciliationHalt(
  state: CircuitBreakerState,
  reconciliation: ReconciliationRecord[],
) {
  if (!state.halted || !state.reason || !state.triggeredAt) return false;
  const match = state.reason.match(/^([a-z]+) canlı mutabakatı başarısız:/i);
  if (!match) return false;
  const recovered = reconciliation.find((item) => item.integrationId === match[1].toLowerCase());
  return recovered?.status === "passed"
    && Boolean(recovered.checkedAt)
    && new Date(recovered.checkedAt!).getTime() > new Date(state.triggeredAt).getTime();
}
