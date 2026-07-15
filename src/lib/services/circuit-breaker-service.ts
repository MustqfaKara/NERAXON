import type { CircuitBreakerState } from "@/lib/domain/types";
import { store } from "@/lib/repositories/store";

export function recordOperationalSuccess() {
  const current = store.getCircuitBreaker();
  if (current.halted || current.consecutiveFailures === 0) return current;
  return save({ ...current, consecutiveFailures: 0 });
}

export function recordOperationalFailure(reason: string) {
  const current = store.getCircuitBreaker();
  const failures = current.consecutiveFailures + 1;
  const halted = current.halted || failures >= (store.getRiskSettings().maxConsecutiveFailures ?? 3);
  return save({
    ...current,
    halted,
    reason: halted ? reason : current.reason,
    consecutiveFailures: failures,
    triggeredAt: halted ? current.triggeredAt ?? new Date().toISOString() : current.triggeredAt,
  });
}

export function haltTrading(reason: string) {
  const now = new Date().toISOString();
  return save({ halted: true, reason, consecutiveFailures: store.getCircuitBreaker().consecutiveFailures, triggeredAt: now, updatedAt: now });
}

export function resetCircuitBreaker() {
  return save({ halted: false, reason: null, consecutiveFailures: 0, triggeredAt: null, updatedAt: new Date().toISOString() });
}

function save(state: CircuitBreakerState) {
  const next = { ...state, updatedAt: new Date().toISOString() };
  store.setCircuitBreaker(next);
  return next;
}
