import type { ChainId, ChainRuntime } from "@/lib/domain/types";
import type { TransactionInspection } from "@/lib/chains/chain-adapter";
import { activityLabel, classifyTransaction, classifyTransactionWithInspection } from "@/lib/chains/transaction-classifier";
import { getChainAdapter } from "@/lib/chains/registry";
import { publishEvent } from "@/lib/services/audit-service";
import { store } from "@/lib/repositories/store";
import { processCopyableSwap } from "@/lib/services/copy-trading-service";
import { isRecoverableOperationalHalt, resetCircuitBreaker } from "@/lib/services/circuit-breaker-service";
import { recordServiceHealth } from "@/lib/services/service-health";
import { executeHypercoreCopyFill } from "@/lib/engine/hypercore-paper-trading";
import { areOnlyStablecoinMovements, isStablecoinSymbol } from "@/lib/engine/stablecoin-filter";
import { isLivePilotIntegration, isShadowTestIntegration, LIVE_PILOT_INTEGRATION_IDS } from "@/lib/domain/integrations";
import { reconcileIntegration, recoverPendingLiveExecutions } from "@/lib/services/live-certification";
import { reconcileSourcePositions } from "@/lib/services/source-position-reconciliation";
import { flushNotificationOutbox } from "@/lib/services/notification-outbox";
import { getRuntimeOwnerId, PRIMARY_RUNTIME_LEASE, PRIMARY_RUNTIME_LEASE_TTL_MS } from "@/lib/services/runtime-instance";

const SOURCE_RECONCILIATION_INTERVAL_MS = 5 * 60_000;
const LIVE_RECONCILIATION_INTERVAL_MS = 30 * 60_000;
const OPERATIONAL_WARNING_INTERVAL_MS = 5 * 60_000;

class BotOrchestrator {
  private readonly ownerId = getRuntimeOwnerId();
  private readonly stopHandlers = new Map<ChainId, () => void>();
  private readonly pendingStarts = new Map<ChainId, Promise<ChainRuntime>>();
  private readonly operationalFailures = new Map<ChainId, number>();
  private pendingReconcile: Promise<void> | null = null;
  private pendingSourceReconciliation: Promise<void> | null = null;
  private pendingLiveReconciliation: Promise<void> | null = null;
  private lastSourceReconciliationAt = 0;
  private lastLiveReconciliationAt = 0;
  private readonly lastOperationalWarningAt = new Map<ChainId, number>();
  private readonly maintenanceTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.maintenanceTimer = setInterval(() => void this.reconcile(), 60_000);
    this.maintenanceTimer.unref?.();
  }

  async start(chainId: ChainId): Promise<ChainRuntime> {
    if (!this.claimPrimaryRuntime()) throw new Error("Bot izleyicileri başka bir NERAXON süreci tarafından yönetiliyor.");
    const pending = this.pendingStarts.get(chainId);
    if (pending) return pending;
    const operation = this.startInternal(chainId);
    this.pendingStarts.set(chainId, operation);
    try {
      return await operation;
    } finally {
      this.pendingStarts.delete(chainId);
    }
  }

  async reconcile() {
    if (this.pendingReconcile) return this.pendingReconcile;
    this.pendingReconcile = this.reconcileInternal();
    try {
      await this.pendingReconcile;
    } finally {
      this.pendingReconcile = null;
    }
  }

  private async reconcileInternal() {
    if (!this.claimPrimaryRuntime()) {
      this.deactivateLocalWatchers();
      return;
    }
    await flushNotificationOutbox();
    await recoverPendingLiveExecutions();
    await this.reconcileShadowSourcesIfDue();
    await this.reconcileLivePortfolioIfDue();
    const breaker = store.getCircuitBreaker();
    if (breaker.halted) {
      if (!isRecoverableOperationalHalt(breaker)) return;
      const healthResults = await Promise.allSettled(store.listChains().map(async (chain) => {
        const health = await getChainAdapter(chain.id).checkHealth();
        recordServiceHealth(`${chain.id}_rpc`, health.latencyMs, null);
        store.updateChain(chain.id, {
          lastBlock: health.blockNumber,
          latencyMs: health.latencyMs,
          errorMessage: null,
        });
        return health;
      }));
      if (healthResults.some((result) => result.status === "rejected")) return;
      resetCircuitBreaker();
      await publishEvent({
        chainId: null,
        level: "info",
        type: "system",
        title: "Ağ bağlantıları otomatik toparlandı",
        message: "Tüm ağ sağlık kontrolleri başarılı. Geçici bağlantı kaynaklı devre kesici sıfırlandı ve izleyiciler yeniden başlatılıyor.",
        txHash: null,
      });
    }

    const mode = store.getMode();
    const isIntegrationInScope = (chainId: ChainId) => mode === "shadow"
      ? isShadowTestIntegration(chainId)
      : mode === "live" ? isLivePilotIntegration(chainId) : true;
    const excludedRunningChains = store.listChains()
      .filter((chain) => !isIntegrationInScope(chain.id) && chain.status !== "stopped");
    await Promise.allSettled(excludedRunningChains.map((chain) => this.stop(chain.id)));

    const recoverableChains = store.listChains().filter((chain) => (
      isIntegrationInScope(chain.id)
      && (chain.status === "error" || (chain.status === "running" && !this.stopHandlers.has(chain.id)))
    ));
    await Promise.allSettled(recoverableChains.map((chain) => this.start(chain.id)));
  }

  private async reconcileShadowSourcesIfDue() {
    if (store.getMode() !== "shadow") return;
    if (this.pendingSourceReconciliation) return this.pendingSourceReconciliation;
    if (Date.now() - this.lastSourceReconciliationAt < SOURCE_RECONCILIATION_INTERVAL_MS) return;
    this.lastSourceReconciliationAt = Date.now();
    this.pendingSourceReconciliation = reconcileSourcePositions({ publishNoop: false }).then(() => undefined);
    try {
      await this.pendingSourceReconciliation;
    } finally {
      this.pendingSourceReconciliation = null;
    }
  }

  private async reconcileLivePortfolioIfDue() {
    if (store.getMode() !== "live") return;
    if (this.pendingLiveReconciliation) return this.pendingLiveReconciliation;
    if (Date.now() - this.lastLiveReconciliationAt < LIVE_RECONCILIATION_INTERVAL_MS) return;
    this.lastLiveReconciliationAt = Date.now();
    this.pendingLiveReconciliation = (async () => {
      for (const chainId of LIVE_PILOT_INTEGRATION_IDS) {
        const chain = store.getChain(chainId);
        if (chain?.status !== "running") continue;
        const previous = store.listReconciliation().find((item) => item.integrationId === chainId);
        const result = await reconcileIntegration(chainId);
        if (result.status === "failed" && (previous?.status !== "failed" || previous.details !== result.details)) {
          await publishEvent({
            chainId,
            level: "warning",
            type: "system",
            title: `${chain.name} periyodik mutabakatı başarısız`,
            message: `${result.details} Yeni canlı emirlerden önce bakiye ve açık lotlar kontrol edilmeli.`,
            txHash: null,
          });
        }
      }
    })();
    try {
      await this.pendingLiveReconciliation;
    } finally {
      this.pendingLiveReconciliation = null;
    }
  }

  dispose() {
    clearInterval(this.maintenanceTimer);
    this.deactivateLocalWatchers();
  }

  private claimPrimaryRuntime() {
    return store.claimRuntimeLease(PRIMARY_RUNTIME_LEASE, this.ownerId, PRIMARY_RUNTIME_LEASE_TTL_MS);
  }

  private deactivateLocalWatchers() {
    for (const stop of this.stopHandlers.values()) stop();
    this.stopHandlers.clear();
  }

  private async startInternal(chainId: ChainId): Promise<ChainRuntime> {
    const chain = store.getChain(chainId);
    if (!chain) throw new Error("Desteklenmeyen ağ.");
    const mode = store.getMode();
    if (mode === "shadow" && !isShadowTestIntegration(chainId)) {
      throw new Error(`${chain.name} ilk shadow test kapsamına dahil değil.`);
    }
    if (mode === "live" && !isLivePilotIntegration(chainId)) {
      throw new Error(`${chain.name} ilk canlı pilot kapsamına dahil değil.`);
    }
    if (store.getCircuitBreaker().halted) throw new Error("Devre kesici aktif; botu başlatmadan önce Risk Ayarları ekranından engeli sıfırla.");
    if (chain.status === "running" && this.stopHandlers.has(chainId)) return chain;
    if (this.stopHandlers.has(chainId)) {
      this.stopHandlers.get(chainId)?.();
      this.stopHandlers.delete(chainId);
    }

    store.updateChain(chainId, { status: "starting", errorMessage: null });
    try {
      const adapter = getChainAdapter(chainId);
      const health = await adapter.checkHealth();
      recordServiceHealth(`${chainId}_rpc`, health.latencyMs, null);
      if (health.latencyMs > (store.getRiskSettings().maxRpcLatencyMs ?? 2_500)) {
        this.operationalFailures.set(chainId, (this.operationalFailures.get(chainId) ?? 0) + 1);
      } else this.operationalFailures.set(chainId, 0);
      store.updateChain(chainId, {
        status: "running",
        lastBlock: health.blockNumber,
        latencyMs: health.latencyMs,
        errorMessage: null,
      });
      if (store.getChainCursor(chainId) === null) {
        store.setChainCursor(chainId, chainId === "hyperliquid" ? Date.now() : health.blockNumber);
      }
      let active = true;
      let stopWatching = () => {};
      stopWatching = adapter.startWatching(
        async (nextHealth) => {
          if (!active) return;
          store.updateChain(chainId, {
            status: "running",
            lastBlock: nextHealth.blockNumber,
            latencyMs: nextHealth.latencyMs,
            errorMessage: null,
          });
          recordServiceHealth(`${chainId}_rpc`, nextHealth.latencyMs, null);
          if (nextHealth.latencyMs > (store.getRiskSettings().maxRpcLatencyMs ?? 2_500)) {
            const failures = (this.operationalFailures.get(chainId) ?? 0) + 1;
            this.operationalFailures.set(chainId, failures);
            if (failures >= (store.getRiskSettings().maxConsecutiveFailures ?? 3)) {
              active = false;
              stopWatching();
              this.stopHandlers.delete(chainId);
              store.updateChain(chainId, { status: "error", errorMessage: `${chain.name} RPC gecikmesi ${nextHealth.latencyMs} ms ile art arda ${failures} kez sınırı aştı.` });
            }
          } else this.operationalFailures.set(chainId, 0);
        },
        async (transactions) => {
          if (!active) return;
          if (!this.claimPrimaryRuntime()) {
            active = false;
            this.deactivateLocalWatchers();
            return;
          }
          for (const transaction of transactions) {
            if (!active) return;
            const wallet = store.findWalletByAddress(transaction.from, chainId);
            if (!wallet || wallet.state === "paused" || !claimObservedTransaction(chainId, transaction.hash)) continue;
            if (chainId === "hyperliquid" && transaction.hypercoreFill) {
              if (isStablecoinSymbol(transaction.hypercoreFill.coin)) continue;
              const activityLimit = store.recordWalletSwapActivity(chainId, wallet.id, transaction.hash);
              if (activityLimit.exceeded) {
                if (activityLimit.newlyPaused) {
                  await publishEvent({
                    chainId,
                    level: "warning",
                    type: "system",
                    title: "Yoğun işlem yapan cüzdan duraklatıldı",
                    message: `${wallet.label} ${activityLimit.reason} nedeniyle otomatik olarak izleme dışına alındı. Bu fill kopyalanmadı; açık pozisyonlar korunuyor.`,
                    txHash: transaction.hash,
                  });
                }
                continue;
              }
              try {
                await executeHypercoreCopyFill(wallet, transaction.hypercoreFill);
              } catch (error) {
                await publishEvent({
                  chainId: "hyperliquid",
                  level: "warning",
                  type: "swap",
                  title: `${transaction.hypercoreFill.coin} copy trade tamamlanamadı`,
                  message: error instanceof Error ? error.message : "HyperCore işlem değerlendirmesi tamamlanamadı.",
                  txHash: transaction.hash,
                });
              }
              continue;
            }
            if (chainId === "solana" && transaction.solanaTransaction) {
              await processCopyableSwap(chainId, wallet, transaction, adapter, "Helius token bakiye değişimleriyle Solana spot swap olarak doğrulandı.");
              continue;
            }
            let activity = classifyTransaction(transaction.input);
            let inspection: TransactionInspection | null = null;
            let classificationReason = activity === "unknown"
              ? "Selector kayıtlı işlem imzalarıyla eşleşmedi."
              : "Metot selector bilinen işlem imzasıyla eşleşti.";
            if (activity === "unknown" && wallet) {
              try {
                inspection = await adapter.inspectTransaction(transaction);
                const inferred = classifyTransactionWithInspection(transaction.input, inspection);
                activity = inferred.activity;
                classificationReason = inferred.reason;
              } catch (error) {
                classificationReason = error instanceof Error
                  ? `Receipt incelemesi tamamlanamadı: ${error.message}`
                  : "Receipt incelemesi tamamlanamadı.";
              }
            }
            if (inspection && areOnlyStablecoinMovements(chainId, inspection.tokenMovements)) continue;
            if (activity === "swap" && wallet) {
              await processCopyableSwap(chainId, wallet, transaction, adapter, classificationReason);
              continue;
            }
            const important = activity === "liquidity_remove";
            if (wallet) store.recordWalletObservation(wallet.id, activity, false);
            let message = `${wallet?.label ?? transaction.from} cüzdanında ${activityLabel(activity).toLocaleLowerCase("tr-TR")} algılandı. Bu işlem kopyalanmadı.${important ? " Cüzdandan kopyalanmış açık pozisyonlar risk izlemeye devam ediyor." : ""}`;
            if (inspection) {
                const movements = inspection.tokenMovements.length
                  ? inspection.tokenMovements.map((movement) => `• ${movement.direction === "in" ? "Gelen" : "Çıkan"}: ${formatMovementAmount(movement.amount)} ${movement.tokenSymbol} (${shortAddress(movement.tokenAddress)})`).join("\n")
                  : "• Cüzdan yönünde ERC-20 hareketi bulunamadı";
                message = [
                  `Cüzdan: ${wallet?.label ?? "Takip edilen cüzdan"}`,
                  `Adres: ${transaction.from}`,
                  `Blok: ${transaction.blockNumber.toLocaleString("tr-TR")}`,
                  `Hedef kontrat: ${inspection.targetAddress ?? "Doğrudan native transfer"}`,
                  `Metot selector: ${inspection.selector || "0x"}`,
                  `Native değer: ${formatMovementAmount(inspection.nativeValue)} ETH`,
                  `Gas maliyeti: ${formatMovementAmount(inspection.gasFeeNative)} ETH`,
                  "Token hareketleri:",
                  movements,
                  `Olası tür: ${inspection.likelyType}`,
                  `Sınıflandırma sonucu: ${activityLabel(activity)}`,
                  `Sınıflandırma nedeni: ${classificationReason}`,
                  "Bot kararı: İşlem kopyalanmadı; açık pozisyonlar değiştirilmedi.",
                ].join("\n");
            } else if (activity === "unknown") {
              message = `${message} ${classificationReason} Hedef: ${transaction.to ?? "native transfer"}, selector: ${transaction.input.slice(0, 10)}, blok: ${transaction.blockNumber.toLocaleString("tr-TR")}.`;
            }
            await publishEvent({
              chainId,
              level: important ? "critical" : activity === "unknown" ? "warning" : "info",
              type: activity,
              title: activityLabel(activity),
              message,
              txHash: transaction.hash,
            });
          }
        },
        () => new Set(store.listActiveWalletAddresses(chainId)),
        async (error) => {
          if (!active) return;
          const failures = (this.operationalFailures.get(chainId) ?? 0) + 1;
          this.operationalFailures.set(chainId, failures);
          const thresholdReached = failures >= (store.getRiskSettings().maxConsecutiveFailures ?? 3);
          const current = store.getChain(chainId);
          if (current?.status === "error" && current.errorMessage === error.message && thresholdReached) return;
          if (thresholdReached) {
            active = false;
            stopWatching();
            this.stopHandlers.delete(chainId);
          }
          store.updateChain(chainId, { status: thresholdReached ? "error" : "running", errorMessage: error.message });
          const serviceId = chainId === "solana" && /websocket/i.test(error.message) ? "solana_ws" : `${chainId}_rpc`;
          recordServiceHealth(serviceId, 0, error.message);
          const now = Date.now();
          const lastWarningAt = this.lastOperationalWarningAt.get(chainId) ?? 0;
          if (thresholdReached || now - lastWarningAt >= OPERATIONAL_WARNING_INTERVAL_MS) {
            this.lastOperationalWarningAt.set(chainId, now);
            await publishEvent({
              chainId,
              level: thresholdReached ? "critical" : "warning",
              type: "system",
              title: thresholdReached ? `${chain.name} botu güvenlik nedeniyle durduruldu` : `${chain.name} RPC izleme hatası`,
              message: thresholdReached
                ? `${error.message} Art arda ${failures} bağlantı hatası oluştu; yalnızca ${chain.name} durduruldu.`
                : `${error.message} Fallback ve replay etkin; benzer uyarılar 5 dakika boyunca birleştirilecek.`,
              txHash: null,
            });
          }
        },
        {
          resumeFromCursor: store.getChainCursor(chainId),
          onCursor: (cursor) => store.setChainCursor(chainId, cursor),
        },
      );
      const stop = () => {
        active = false;
        stopWatching();
      };
      this.stopHandlers.set(chainId, stop);
      await publishEvent({
        chainId,
        level: "info",
        type: "system",
        title: `${chain.name} botu çalışıyor`,
        message: chain.kind === "venue"
          ? "Canlı kullanıcı fill akışı üzerinden spot ve perpetual cüzdan izleme başlatıldı."
          : chain.kind === "solana"
            ? `Slot ${health.blockNumber.toLocaleString("tr-TR")} üzerinden Helius canlı spot swap izleme başlatıldı.`
          : `Blok ${health.blockNumber.toLocaleString("tr-TR")} üzerinden cüzdan izleme başlatıldı.`,
        txHash: null,
      });
      return store.getChain(chainId)!;
    } catch (error) {
      const message = error instanceof Error ? error.message : "RPC bağlantısı kurulamadı.";
      store.updateChain(chainId, { status: "error", errorMessage: message });
      recordServiceHealth(`${chainId}_rpc`, 0, message);
      await publishEvent({
        chainId,
        level: "critical",
        type: "system",
        title: `${chain.name} botu başlatılamadı`,
        message,
        txHash: null,
      });
      throw error;
    }
  }

  async stop(chainId: ChainId) {
    const chain = store.getChain(chainId);
    if (!chain) throw new Error("Desteklenmeyen ağ.");
    store.updateChain(chainId, { status: "stopping" });
    this.stopHandlers.get(chainId)?.();
    this.stopHandlers.delete(chainId);
    this.operationalFailures.set(chainId, 0);
    const stopped = store.updateChain(chainId, { status: "stopped", errorMessage: null });
    await publishEvent({
      chainId,
      level: "info",
      type: "system",
      title: `${chain.name} botu durduruldu`,
      message: "Yeni işlemler alınmayacak. Açık paper pozisyonları korunuyor.",
      txHash: null,
    });
    return stopped;
  }
}

const formatMovementAmount = (value: number) => value.toLocaleString("tr-TR", { maximumFractionDigits: 8 });
const shortAddress = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;

const OBSERVED_TRANSACTION_TTL_MS = 60 * 60 * 1_000;
const ORCHESTRATOR_VERSION = 22;
const globalState = globalThis as typeof globalThis & {
  neraxonOrchestrator?: BotOrchestrator;
  neraxonOrchestratorVersion?: number;
  neraxonObservedTransactions?: Map<string, number>;
};

function claimObservedTransaction(chainId: ChainId, transactionHash: string) {
  const now = Date.now();
  const key = `${chainId}:${transactionHash.toLowerCase()}`;
  const observed = (globalState.neraxonObservedTransactions ??= new Map());
  const claimedAt = observed.get(key);
  if (claimedAt && now - claimedAt < OBSERVED_TRANSACTION_TTL_MS) return false;
  observed.set(key, now);
  if (observed.size > 10_000) {
    for (const [storedKey, storedAt] of observed) {
      if (now - storedAt >= OBSERVED_TRANSACTION_TTL_MS) observed.delete(storedKey);
    }
  }
  return true;
}

export const getBotOrchestrator = () => {
  if (!globalState.neraxonOrchestrator || globalState.neraxonOrchestratorVersion !== ORCHESTRATOR_VERSION) {
    const previous = globalState.neraxonOrchestrator as unknown as {
      dispose?: () => void;
      stopHandlers?: Map<ChainId, () => void>;
    } | undefined;
    if (typeof previous?.dispose === "function") {
      previous.dispose();
    } else {
      for (const stop of previous?.stopHandlers?.values() ?? []) stop();
      previous?.stopHandlers?.clear();
    }
    globalState.neraxonOrchestrator = new BotOrchestrator();
    globalState.neraxonOrchestratorVersion = ORCHESTRATOR_VERSION;
  }
  return globalState.neraxonOrchestrator;
};
