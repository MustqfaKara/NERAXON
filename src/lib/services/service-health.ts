import type { ServiceHealthMetric } from "../domain/types.ts";

interface MutableMetric extends ServiceHealthMetric { totalLatencyMs: number }

const labels: Record<string, string> = {
  dexscreener: "DexScreener",
  geckoterminal: "GeckoTerminal",
  ethereum_rpc: "Ethereum RPC",
  base_rpc: "Base RPC",
  robinhood_rpc: "Robinhood RPC",
  solana_rpc: "Solana RPC",
  solana_ws: "Helius WebSocket",
  helius: "Helius API",
  birdeye: "Birdeye API",
  hyperliquid_rpc: "Hyperliquid API",
  hyperliquid_info: "HyperCore Info API",
  hyperliquid_leaderboard: "Hyperliquid Leaderboard",
  telegram: "Telegram",
  telegram_user: "Telegram Kullanıcı Oturumu",
  etherscan: "Etherscan",
  jupiter: "Jupiter API",
  zeroex: "0x Swap API",
  lifi: "LI.FI API",
  groq_ai: "Groq AI",
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
    current.consecutiveErrors += 1;
    current.lastError = error;
    current.lastErrorAt = new Date().toISOString();
    if (/429|rate.?limit|too many requests|compute units usage limit exceeded/i.test(error)) {
      current.rateLimitedUntil = new Date(Date.now() + 60_000).toISOString();
    }
  } else {
    current.consecutiveErrors = 0;
    current.lastSuccessAt = new Date().toISOString();
    if (current.rateLimitedUntil && current.rateLimitedUntil <= current.lastSuccessAt) current.rateLimitedUntil = null;
  }
  current.status = error ? (current.lastSuccessAt ? "degraded" : "down") : current.averageLatencyMs > 2_500 ? "degraded" : "healthy";
  metrics().set(id, current);
}

export function listServiceHealth(): ServiceHealthMetric[] {
  return Object.keys(labels).map((id) => {
    const current = metrics().get(id) ?? emptyMetric(id);
    return {
      id: current.id, label: current.label, status: current.status, requestCount: current.requestCount,
      errorCount: current.errorCount, cacheHitCount: current.cacheHitCount, averageLatencyMs: current.averageLatencyMs,
      lastSuccessAt: current.lastSuccessAt, lastErrorAt: current.lastErrorAt, lastError: current.lastError,
      consecutiveErrors: current.consecutiveErrors, rateLimitedUntil: current.rateLimitedUntil, reconnectCount: current.reconnectCount,
    };
  });
}

export function recordServiceReconnect(id: string) {
  const current = metrics().get(id) ?? emptyMetric(id);
  current.reconnectCount += 1;
  metrics().set(id, current);
}

function emptyMetric(id: string): MutableMetric {
  return {
    id, label: labels[id] ?? id, status: "idle", requestCount: 0, errorCount: 0, cacheHitCount: 0,
    averageLatencyMs: 0, lastSuccessAt: null, lastErrorAt: null, lastError: null, consecutiveErrors: 0,
    rateLimitedUntil: null, reconnectCount: 0, totalLatencyMs: 0,
  };
}
