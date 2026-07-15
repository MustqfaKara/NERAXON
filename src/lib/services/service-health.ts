import type { ServiceHealthMetric } from "../domain/types.ts";

interface MutableMetric extends ServiceHealthMetric { totalLatencyMs: number }

const labels: Record<string, string> = {
  dexscreener: "DexScreener",
  ethereum_rpc: "Ethereum RPC",
  base_rpc: "Base RPC",
  telegram: "Telegram",
  etherscan: "Etherscan",
};
const globalState = globalThis as typeof globalThis & { neraxonHealth?: Map<string, MutableMetric> };
const metrics = () => (globalState.neraxonHealth ??= new Map());

export async function monitorService<T>(id: string, operation: () => Promise<T>, options?: { cacheHit?: boolean }) {
  const startedAt = performance.now();
  try {
    const result = await operation();
    recordServiceHealth(id, performance.now() - startedAt, null, options?.cacheHit ?? false);
    return result;
  } catch (error) {
    recordServiceHealth(id, performance.now() - startedAt, error instanceof Error ? error.message : "Bilinmeyen servis hatası", false);
    throw error;
  }
}

export function recordServiceHealth(id: string, latencyMs: number, error: string | null, cacheHit = false) {
  const current = metrics().get(id) ?? emptyMetric(id);
  current.requestCount += 1;
  current.totalLatencyMs += Math.max(0, latencyMs);
  current.averageLatencyMs = Math.round(current.totalLatencyMs / current.requestCount);
  if (cacheHit) current.cacheHitCount += 1;
  if (error) {
    current.errorCount += 1;
    current.lastError = error;
    current.lastErrorAt = new Date().toISOString();
  } else {
    current.lastSuccessAt = new Date().toISOString();
  }
  current.status = error ? (current.lastSuccessAt ? "degraded" : "down") : current.averageLatencyMs > 2_500 ? "degraded" : "healthy";
  metrics().set(id, current);
}

export function listServiceHealth(): ServiceHealthMetric[] {
  return Object.keys(labels).map((id) => {
    const current = metrics().get(id) ?? emptyMetric(id);
    return { id: current.id, label: current.label, status: current.status, requestCount: current.requestCount, errorCount: current.errorCount, cacheHitCount: current.cacheHitCount, averageLatencyMs: current.averageLatencyMs, lastSuccessAt: current.lastSuccessAt, lastErrorAt: current.lastErrorAt, lastError: current.lastError };
  });
}

function emptyMetric(id: string): MutableMetric {
  return { id, label: labels[id] ?? id, status: "idle", requestCount: 0, errorCount: 0, cacheHitCount: 0, averageLatencyMs: 0, lastSuccessAt: null, lastErrorAt: null, lastError: null, totalLatencyMs: 0 };
}
