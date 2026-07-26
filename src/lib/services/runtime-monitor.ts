import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { store } from "@/lib/repositories/store";
import { publishEvent } from "@/lib/services/audit-service";
import { flushNotificationOutbox } from "@/lib/services/notification-outbox";
import { listServiceHealth } from "@/lib/services/service-health";
import { getShadowPortfolio } from "@/lib/services/execution-accounting";
import { finalizeShadowSoak } from "@/lib/services/shadow-soak-report";
import { isSoakBlockingCriticalEvent } from "@/lib/services/shadow-soak-gate";
import { getRuntimeOwnerId, PRIMARY_RUNTIME_LEASE, PRIMARY_RUNTIME_LEASE_TTL_MS } from "@/lib/services/runtime-instance";

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_LOG_INTERVAL_MS = 5 * 60_000;
const HEALTH_SAMPLE_INTERVAL_MS = 60_000;
const PORTFOLIO_SAMPLE_INTERVAL_MS = 5 * 60_000;
const MAX_HEARTBEAT_GAP_MS = 90_000;

interface RuntimeMonitorState {
  version: number;
  sessionId: string;
  ownerId: string;
  timer: ReturnType<typeof setInterval>;
  lastLoggedAt: number;
  lastHeartbeatAt: number;
  lastHealthSampleAt: number;
  lastPortfolioSampleAt: number;
}

const RUNTIME_MONITOR_VERSION = 3;
const globalState = globalThis as typeof globalThis & { neraxonRuntimeMonitor?: RuntimeMonitorState };

export async function ensureRuntimeMonitor() {
  if (globalState.neraxonRuntimeMonitor?.version === RUNTIME_MONITOR_VERSION) return;
  if (globalState.neraxonRuntimeMonitor) {
    clearInterval(globalState.neraxonRuntimeMonitor.timer);
    store.stopRuntimeSession(globalState.neraxonRuntimeMonitor.sessionId, "stopped", "Runtime kodu yenilendi.");
    globalState.neraxonRuntimeMonitor = undefined;
  }

  const ownerId = getRuntimeOwnerId();
  if (!store.claimRuntimeLease(PRIMARY_RUNTIME_LEASE, ownerId, PRIMARY_RUNTIME_LEASE_TTL_MS)) return;

  const interruptedSoak = store.getRunningShadowSoak();
  const interrupted = store.interruptStaleRuntimeSessions();
  if (interrupted > 0 && interruptedSoak) {
    await finalizeShadowSoak(interruptedSoak, "failed", "Çalışma süreci heartbeat üretmeden sonlandı veya yeniden başlatıldı.");
  }

  const startedAt = new Date().toISOString();
  const sessionId = crypto.randomUUID();
  store.startRuntimeSession({ id: sessionId, mode: store.getMode(), processId: process.pid, startedAt });
  appendRuntimeLog("runtime_started", { sessionId, processId: process.pid, interruptedSessions: interrupted });

  if (interrupted > 0) {
    await publishEvent({
      chainId: null,
      level: "warning",
      type: "system",
      title: "Beklenmeyen çalışma kesintisi algılandı",
      message: `${interrupted} önceki çalışma oturumu temiz kapanış kaydı bırakmadı. Ağ cursorları üzerinden kaçırılan işlemler yeniden taranıyor.`,
      txHash: null,
    });
  }

  const state: RuntimeMonitorState = {
    version: RUNTIME_MONITOR_VERSION,
    sessionId,
    ownerId,
    lastLoggedAt: Date.now(),
    lastHeartbeatAt: Date.now(),
    lastHealthSampleAt: 0,
    lastPortfolioSampleAt: 0,
    timer: setInterval(() => {
      if (!store.claimRuntimeLease(PRIMARY_RUNTIME_LEASE, ownerId, PRIMARY_RUNTIME_LEASE_TTL_MS)) {
        clearInterval(state.timer);
        store.stopRuntimeSession(sessionId, "interrupted", "Birincil çalışma kilidi başka sürece geçti.");
        globalState.neraxonRuntimeMonitor = undefined;
        return;
      }
      const timestamp = Date.now();
      const now = new Date(timestamp).toISOString();
      const gapMs = timestamp - state.lastHeartbeatAt;
      state.lastHeartbeatAt = timestamp;
      store.heartbeatRuntimeSession(sessionId, now);
      store.recordRuntimeHeartbeat(sessionId, now, gapMs);
      const interrupted = Number(store.interruptStaleRuntimeSessions(new Date(timestamp - MAX_HEARTBEAT_GAP_MS).toISOString()));
      if (interrupted > 0) void failSoakForInterruptedRuntime(interrupted);
      void flushNotificationOutbox();
      void evaluateShadowSoak(gapMs);
      captureTelemetry(state, now, timestamp);
      if (timestamp - state.lastLoggedAt >= HEARTBEAT_LOG_INTERVAL_MS) {
        appendRuntimeLog("heartbeat", { sessionId, at: now });
        state.lastLoggedAt = timestamp;
      }
    }, HEARTBEAT_INTERVAL_MS),
  };
  state.timer.unref?.();
  globalState.neraxonRuntimeMonitor = state;

  process.once("exit", () => {
    store.stopRuntimeSession(sessionId, "stopped", "Process normal şekilde sonlandı.");
    store.releaseRuntimeLease(PRIMARY_RUNTIME_LEASE, ownerId);
    appendRuntimeLog("runtime_stopped", { sessionId });
  });
}

async function failSoakForInterruptedRuntime(interruptedSessions: number) {
  const soak = store.getRunningShadowSoak();
  if (!soak) return;
  await finalizeShadowSoak(soak, "failed", `${interruptedSessions} çalışma oturumu heartbeat üretmeden sonlandı.`);
}

async function evaluateShadowSoak(gapMs: number) {
  const soak = store.getRunningShadowSoak();
  if (!soak) return;
  if (gapMs > MAX_HEARTBEAT_GAP_MS) {
    await finalizeShadowSoak(soak, "failed", `Heartbeat boşluğu ${gapMs} ms ile ${MAX_HEARTBEAT_GAP_MS} ms sınırını aştı.`);
    return;
  }
  if (Date.parse(String(soak.target_end_at)) > Date.now()) return;
  const criticalEvents = store.listEvents(10_000).filter((event) => (
    isSoakBlockingCriticalEvent(event) && Date.parse(event.createdAt) >= Date.parse(String(soak.started_at))
  ));
  if (criticalEvents.length) {
    await finalizeShadowSoak(soak, "failed", `Doğrulama süresinde ${criticalEvents.length} kritik olay oluştu.`);
    return;
  }
  await finalizeShadowSoak(soak, "passed", null);
  appendRuntimeLog("shadow_soak_passed", { id: String(soak.id) });
}

export async function startNewShadowSoak(durationHours = 24) {
  if (store.getMode() !== "shadow") throw new Error("Shadow soak yalnızca shadow modda başlatılabilir.");
  const existing = store.getRunningShadowSoak();
  if (existing) await finalizeShadowSoak(existing, "failed", "Yeni doğrulama oturumu başlatıldı.");
  const startedAt = new Date();
  const id = crypto.randomUUID();
  const targetEndAt = new Date(startedAt.getTime() + durationHours * 60 * 60_000);
  store.startShadowSoak({
    id,
    startedAt: startedAt.toISOString(),
    targetEndAt: targetEndAt.toISOString(),
    baseline: {
      eventCount: store.listEvents(10_000).length,
      executionAttemptCount: store.listExecutionAttempts(10_000).length,
      chainCursors: Object.fromEntries(store.listChains().map((chain) => [chain.id, store.getChainCursor(chain.id)])),
    },
  });
  const sampledAt = new Date().toISOString();
  store.recordServiceHealthSamples(id, sampledAt, listServiceHealth());
  store.recordPortfolioSnapshots(id, sampledAt, getShadowPortfolio());
  await publishEvent({
    chainId: null,
    level: "info",
    type: "system",
    title: "24 saatlik shadow doğrulaması başladı",
    message: `Kesintisiz çalışma, replay, bildirim kuyruğu, kaynak bakiye mutabakatı ve PnL muhasebesi ${targetEndAt.toLocaleString("tr-TR")} tarihine kadar izlenecek.`,
    txHash: null,
  });
  return { id, startedAt: startedAt.toISOString(), targetEndAt: targetEndAt.toISOString() };
}

function captureTelemetry(state: RuntimeMonitorState, sampledAt: string, timestamp: number) {
  const soakId = String(store.getRunningShadowSoak()?.id ?? "") || null;
  if (timestamp - state.lastHealthSampleAt >= HEALTH_SAMPLE_INTERVAL_MS) {
    store.recordServiceHealthSamples(soakId, sampledAt, listServiceHealth());
    state.lastHealthSampleAt = timestamp;
  }
  if (timestamp - state.lastPortfolioSampleAt >= PORTFOLIO_SAMPLE_INTERVAL_MS) {
    store.recordPortfolioSnapshots(soakId, sampledAt, getShadowPortfolio());
    state.lastPortfolioSampleAt = timestamp;
  }
}

function appendRuntimeLog(type: string, details: Record<string, unknown>) {
  const directory = path.join(process.cwd(), "data", "logs");
  mkdirSync(directory, { recursive: true });
  appendFileSync(path.join(directory, "neraxon-runtime.jsonl"), `${JSON.stringify({ type, ...details })}\n`, "utf8");
}
