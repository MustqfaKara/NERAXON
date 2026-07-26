import assert from "node:assert/strict";
import test from "node:test";
import { summarizeHeartbeats, summarizePortfolios, summarizeServices } from "../src/lib/engine/shadow-soak-summary.ts";

test("heartbeat boşluklarını ve sınır aşımını özetler", () => {
  assert.deepEqual(summarizeHeartbeats([{ gap_ms: 30_000 }, { gap_ms: 95_000 }]), {
    sampleCount: 2,
    maximumGapMs: 95_000,
    averageGapMs: 62_500,
    gapsOver90Seconds: 1,
  });
});

test("servis sayaçlarını soak aralığındaki artış olarak hesaplar", () => {
  const result = summarizeServices([
    { service_id: "base_rpc", status: "healthy", request_count: 10, error_count: 1, cache_hit_count: 2, average_latency_ms: 100, reconnect_count: 0 },
    { service_id: "base_rpc", status: "degraded", request_count: 18, error_count: 3, cache_hit_count: 5, average_latency_ms: 300, reconnect_count: 1, last_error: "timeout" },
  ]);
  assert.equal(result.base_rpc.requestCount, 8);
  assert.equal(result.base_rpc.errorCount, 2);
  assert.equal(result.base_rpc.reconnectCount, 1);
  assert.equal(result.base_rpc.degradedSamples, 1);
  assert.equal(result.base_rpc.lastError, "timeout");
});

test("ağ portföyünün başlangıç, bitiş ve minimum değerlerini saklar", () => {
  const result = summarizePortfolios([
    { integration_id: "solana", equity_usd: 33, realized_pnl_usd: 0, unrealized_pnl_usd: 0, position_unrealized_pnl_usd: 0, funding_token_pnl_usd: 0, total_costs_usd: 0, open_position_count: 0 },
    { integration_id: "solana", equity_usd: 31, realized_pnl_usd: -1, unrealized_pnl_usd: -1, position_unrealized_pnl_usd: 0, funding_token_pnl_usd: -1, total_costs_usd: 0.2, open_position_count: 1 },
    { integration_id: "solana", equity_usd: 34, realized_pnl_usd: 1, unrealized_pnl_usd: 0, position_unrealized_pnl_usd: 0, funding_token_pnl_usd: 0, total_costs_usd: 0.3, open_position_count: 0 },
  ]);
  assert.equal(result.solana.startingEquityUsd, 33);
  assert.equal(result.solana.endingEquityUsd, 34);
  assert.equal(result.solana.minimumEquityUsd, 31);
  assert.equal(result.solana.totalCostsUsd, 0.3);
});
