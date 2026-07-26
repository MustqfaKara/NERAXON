import { store } from "@/lib/repositories/store";
import { summarizeHeartbeats, summarizePortfolios, summarizeServices } from "@/lib/engine/shadow-soak-summary";

export async function finalizeShadowSoak(
  soak: Record<string, unknown>,
  status: "passed" | "failed",
  failureReason: string | null,
) {
  const id = String(soak.id);
  const startedAt = String(soak.started_at);
  const endedAt = new Date().toISOString();
  const healthRows = store.listServiceHealthSamples(id);
  const portfolioRows = store.listPortfolioSnapshots(id);
  const heartbeats = store.listRuntimeHeartbeats(startedAt, endedAt);
  const counts = store.getSoakDatabaseCounts(startedAt, endedAt);
  const result = {
    soakId: id,
    status,
    failureReason,
    startedAt,
    endedAt,
    durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
    heartbeat: summarizeHeartbeats(heartbeats),
    services: summarizeServices(healthRows),
    portfolios: summarizePortfolios(portfolioRows),
    database: counts,
    endingCursors: Object.fromEntries(store.listChains().map((chain) => [chain.id, store.getChainCursor(chain.id)])),
  };
  store.finalizeShadowSoak(id, status, failureReason, result);
  return result;
}
