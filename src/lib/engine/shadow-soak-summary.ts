import type { ChainId } from "../domain/types.ts";

export function summarizeHeartbeats(rows: Record<string, unknown>[]) {
  const gaps = rows.map((row) => Number(row.gap_ms ?? 0));
  return {
    sampleCount: gaps.length,
    maximumGapMs: gaps.length ? Math.max(...gaps) : null,
    averageGapMs: gaps.length ? Math.round(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length) : null,
    gapsOver90Seconds: gaps.filter((gap) => gap > 90_000).length,
  };
}

export function summarizeServices(rows: Record<string, unknown>[]) {
  const grouped = groupBy(rows, (row) => String(row.service_id));
  return Object.fromEntries([...grouped].map(([serviceId, samples]) => {
    const first = samples[0];
    const last = samples.at(-1)!;
    const latencies = samples.map((sample) => Number(sample.average_latency_ms ?? 0));
    return [serviceId, {
      sampleCount: samples.length,
      requestCount: counterDelta(first, last, "request_count"),
      errorCount: counterDelta(first, last, "error_count"),
      cacheHitCount: counterDelta(first, last, "cache_hit_count"),
      reconnectCount: counterDelta(first, last, "reconnect_count"),
      averageLatencyMs: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : 0,
      maximumAverageLatencyMs: latencies.length ? Math.max(...latencies) : 0,
      degradedSamples: samples.filter((sample) => sample.status === "degraded").length,
      downSamples: samples.filter((sample) => sample.status === "down").length,
      lastError: last.last_error ?? null,
    }];
  }));
}

export function summarizePortfolios(rows: Record<string, unknown>[]) {
  const grouped = groupBy(rows, (row) => String(row.integration_id) as ChainId);
  return Object.fromEntries([...grouped].map(([integrationId, samples]) => {
    const first = samples[0];
    const last = samples.at(-1)!;
    const equities = samples.map((sample) => Number(sample.equity_usd));
    return [integrationId, {
      sampleCount: samples.length,
      startingEquityUsd: Number(first.equity_usd),
      endingEquityUsd: Number(last.equity_usd),
      minimumEquityUsd: Math.min(...equities),
      maximumEquityUsd: Math.max(...equities),
      realizedPnlUsd: Number(last.realized_pnl_usd),
      unrealizedPnlUsd: Number(last.unrealized_pnl_usd),
      positionUnrealizedPnlUsd: Number(last.position_unrealized_pnl_usd),
      fundingTokenPnlUsd: Number(last.funding_token_pnl_usd),
      totalCostsUsd: Number(last.total_costs_usd),
      openPositionCount: Number(last.open_position_count),
    }];
  }));
}

function counterDelta(first: Record<string, unknown>, last: Record<string, unknown>, key: string) {
  return Math.max(0, Number(last[key] ?? 0) - Number(first[key] ?? 0));
}

function groupBy<T, K>(items: T[], key: (item: T) => K) {
  const grouped = new Map<K, T[]>();
  for (const item of items) grouped.set(key(item), [...(grouped.get(key(item)) ?? []), item]);
  return grouped;
}
