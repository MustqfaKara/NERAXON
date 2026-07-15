import type { ChainId, ChainRuntime } from "@/lib/domain/types";
import type { TransactionInspection } from "@/lib/chains/chain-adapter";
import { activityLabel, classifyTransaction, classifyTransactionWithInspection } from "@/lib/chains/transaction-classifier";
import { getChainAdapter } from "@/lib/chains/registry";
import { publishEvent } from "@/lib/services/audit-service";
import { store } from "@/lib/repositories/store";
import { processCopyableSwap } from "@/lib/services/copy-trading-service";
import { recordOperationalFailure, recordOperationalSuccess } from "@/lib/services/circuit-breaker-service";
import { recordServiceHealth } from "@/lib/services/service-health";

class BotOrchestrator {
  private readonly stopHandlers = new Map<ChainId, () => void>();
  private readonly pendingStarts = new Map<ChainId, Promise<ChainRuntime>>();

  async start(chainId: ChainId): Promise<ChainRuntime> {
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
    const runningChains = store.listChains().filter((chain) => chain.status === "running" && !this.stopHandlers.has(chain.id));
    await Promise.allSettled(runningChains.map((chain) => this.start(chain.id)));
  }

  dispose() {
    for (const stop of this.stopHandlers.values()) stop();
    this.stopHandlers.clear();
  }

  private async startInternal(chainId: ChainId): Promise<ChainRuntime> {
    const chain = store.getChain(chainId);
    if (!chain) throw new Error("Desteklenmeyen ağ.");
    if (store.getCircuitBreaker().halted) throw new Error("Devre kesici aktif; botu başlatmadan önce Risk Ayarları ekranından engeli sıfırla.");
    if (chain.status === "running" && this.stopHandlers.has(chainId)) return chain;

    store.updateChain(chainId, { status: "starting", errorMessage: null });
    try {
      const adapter = getChainAdapter(chainId);
      const health = await adapter.checkHealth();
      recordServiceHealth(`${chainId}_rpc`, health.latencyMs, null);
      if (health.latencyMs > (store.getRiskSettings().maxRpcLatencyMs ?? 2_500)) {
        recordOperationalFailure(`${chain.name} RPC gecikmesi ${health.latencyMs} ms ile sınırı aştı.`);
      } else recordOperationalSuccess();
      store.updateChain(chainId, {
        status: "running",
        lastBlock: health.blockNumber,
        latencyMs: health.latencyMs,
        errorMessage: null,
      });
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
            const breaker = recordOperationalFailure(`${chain.name} RPC gecikmesi ${nextHealth.latencyMs} ms ile sınırı aştı.`);
            if (breaker.halted) {
              active = false;
              stopWatching();
              this.stopHandlers.delete(chainId);
              store.updateChain(chainId, { status: "error", errorMessage: breaker.reason });
            }
          } else recordOperationalSuccess();
        },
        async (transactions) => {
          if (!active) return;
          for (const transaction of transactions) {
            if (!active) return;
            const wallet = store.findWalletByAddress(transaction.from);
            if (!wallet || wallet.state === "paused" || !claimObservedTransaction(chainId, transaction.hash)) continue;
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
            if (activity === "swap" && wallet) {
              const activityLimit = store.recordWalletSwapActivity(chainId, wallet.id, transaction.hash);
              if (activityLimit.exceeded) {
                if (activityLimit.newlyPaused) {
                  await publishEvent({
                    chainId,
                    level: "warning",
                    type: "system",
                    title: "Yoğun işlem yapan cüzdan duraklatıldı",
                    message: `${wallet.label} otomatik olarak izleme dışına alındı. ${activityLimit.reason} Bu swap kopyalanmadı; açık pozisyonlar korunuyor. Cüzdanlar sayfasından yeniden etkinleştirebilirsin.`,
                    txHash: transaction.hash,
                  });
                }
                continue;
              }
              await publishEvent({
                chainId,
                level: "info",
                type: "swap",
                title: "Swap değerlendirmeye alındı",
                message: `${wallet.label} cüzdanının işlemi swap olarak doğrulandı; token hareketleri ve piyasa koşulları inceleniyor. ${classificationReason}`,
                txHash: transaction.hash,
              });
              await processCopyableSwap(chainId, wallet, transaction, adapter);
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
        () => new Set(store.listActiveWalletAddresses()),
        async (error) => {
          if (!active) return;
          const current = store.getChain(chainId);
          if (current?.status === "error" && current.errorMessage === error.message) return;
          store.updateChain(chainId, { status: "error", errorMessage: error.message });
          recordServiceHealth(`${chainId}_rpc`, 0, error.message);
          const breaker = recordOperationalFailure(error.message);
          if (breaker.halted) {
            active = false;
            stopWatching();
            this.stopHandlers.delete(chainId);
          }
          await publishEvent({
            chainId,
            level: "critical",
            type: "system",
            title: `${chain.name} RPC izleme hatası`,
            message: error.message,
            txHash: null,
          });
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
        message: `Blok ${health.blockNumber.toLocaleString("tr-TR")} üzerinden cüzdan izleme başlatıldı.`,
        txHash: null,
      });
      return store.getChain(chainId)!;
    } catch (error) {
      const message = error instanceof Error ? error.message : "RPC bağlantısı kurulamadı.";
      store.updateChain(chainId, { status: "error", errorMessage: message });
      recordServiceHealth(`${chainId}_rpc`, 0, message);
      recordOperationalFailure(message);
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
const ORCHESTRATOR_VERSION = 7;
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
