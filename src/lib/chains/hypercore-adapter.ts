import { SubscriptionClient, WebSocketTransport, type ISubscription, type UserFillsWsEvent } from "@nktkas/hyperliquid";
import type { ChainAdapter, ChainHealth, ChainWatchOptions, ObservedTransaction, SwapObservation, TransactionInspection } from "@/lib/chains/chain-adapter";
import type { HypercoreFillObservation } from "@/lib/domain/types";
import { isUserTerminatedWebSocket, shardHypercoreAddresses } from "@/lib/chains/hypercore-websocket-sharding";
import { getHypercoreHealth, getHypercoreUserFills } from "@/lib/services/hypercore-api";
import { recordServiceReconnect } from "@/lib/services/service-health";
import { readCredentialSync } from "@/lib/security/credential-vault";

const WS_URL = readCredentialSync("hyperliquid-ws-url") ?? "wss://api.hyperliquid.xyz/ws";

interface HypercoreSocketShard {
  transport: WebSocketTransport;
  subscriptions: ISubscription[];
}

export class HypercoreAdapter implements ChainAdapter {
  readonly id = "hyperliquid" as const;

  checkHealth(): Promise<ChainHealth> {
    return getHypercoreHealth();
  }

  async analyzeSwap(transaction: ObservedTransaction): Promise<SwapObservation | null> {
    const fill = transaction.hypercoreFill;
    if (!fill) return null;
    return {
      txHash: fill.id,
      side: fill.side,
      tokenAddress: `${fill.marketType}:${fill.coin}`.toLowerCase(),
      tokenSymbol: fill.coin,
      tokenDecimals: 8,
      tokenAmount: fill.quantity,
      sourceAmount: fill.notionalUsd,
    };
  }

  async inspectTransaction(transaction: ObservedTransaction): Promise<TransactionInspection> {
    const fill = transaction.hypercoreFill;
    return {
      targetAddress: null,
      selector: "hypercore",
      nativeValue: fill?.notionalUsd ?? 0,
      gasFeeNative: fill?.feeUsd ?? 0,
      tokenMovements: fill ? [{
        tokenAddress: `${fill.marketType}:${fill.coin}`.toLowerCase(),
        tokenSymbol: fill.coin,
        direction: fill.side === "buy" ? "in" : "out",
        amount: fill.quantity,
      }] : [],
      likelyType: fill ? `HyperCore ${fill.marketType} fill` : "Bilinmeyen HyperCore olayı",
    };
  }

  startWatching(
    onBlock: (health: ChainHealth) => Promise<void>,
    onTransactions: (transactions: ObservedTransaction[]) => Promise<void>,
    trackedAddresses: () => Set<string>,
    onError: (error: Error) => Promise<void>,
    options: ChainWatchOptions = {},
  ) {
    let active = true;
    let healthTimer: ReturnType<typeof setInterval> | null = null;
    let syncTimer: ReturnType<typeof setInterval> | null = null;
    let syncing = false;
    let targetFingerprint = "";
    let failureTimestamps: number[] = [];
    let lastReportedFailureAt = 0;
    const shards: HypercoreSocketShard[] = [];

    const replayMissedFills = async () => {
      if (options.resumeFromCursor === null || options.resumeFromCursor === undefined) return;
      const fills = (await Promise.all([...trackedAddresses()].map((address) => (
        getHypercoreUserFills(address, options.resumeFromCursor! + 1)
      )))).flat().sort((left, right) => left.timestamp - right.timestamp);
      for (const fill of fills) {
        await onTransactions([toObservedTransaction(fill)]);
        options.onCursor?.(fill.timestamp);
      }
    };

    const reportError = (error: unknown) => {
      if (!active) return;
      void onError(toWebSocketError(error));
    };

    const handleRecoverableFailure = (error: unknown) => {
      if (!active) return;
      targetFingerprint = "";
      const now = Date.now();
      failureTimestamps = failureTimestamps.filter((timestamp) => now - timestamp < 5 * 60_000);
      failureTimestamps.push(now);
      if (failureTimestamps.length < 3 || now - lastReportedFailureAt < 5 * 60_000) return;
      lastReportedFailureAt = now;
      reportError(new Error(`${errorDetail(error)} Son 5 dakikada ${failureTimestamps.length} bağlantı/abonelik hatası oluştu.`));
    };

    const closeShards = async () => {
      const current = shards.splice(0);
      await Promise.allSettled(current.flatMap((shard) => shard.subscriptions.map((subscription) => subscription.unsubscribe())));
      await Promise.allSettled(current.map((shard) => shard.transport.close()));
    };

    const synchronizeSubscriptions = async () => {
      if (!active || syncing) return;
      syncing = true;
      try {
        const groups = shardHypercoreAddresses(trackedAddresses());
        const nextFingerprint = groups.flat().join(",");
        if (nextFingerprint === targetFingerprint) return;
        targetFingerprint = "";
        await closeShards();

        for (const addresses of groups) {
          if (!active) return;
          const transport = new WebSocketTransport({
            url: WS_URL,
            timeout: 30_000,
            resubscribe: true,
            reconnect: {
              maxRetries: Number.POSITIVE_INFINITY,
              connectionTimeout: 15_000,
              reconnectionDelay: (attempt) => Math.min(1_000 * 2 ** Math.min(attempt, 5), 30_000),
            },
          });
          const shard: HypercoreSocketShard = { transport, subscriptions: [] };
          shards.push(shard);
          transport.socket.addEventListener("terminate", (event) => {
            if (isUserTerminatedWebSocket(event.detail)) return;
            recordServiceReconnect("hyperliquid_rpc");
            handleRecoverableFailure(event.detail);
          });
          await transport.ready(AbortSignal.timeout(20_000));
          const client = new SubscriptionClient({ transport });
          for (const address of addresses) {
            const subscription = await client.userFills({ user: address as `0x${string}` }, (message) => {
              if (!active || message.isSnapshot) return;
              void this.handleUserFills(message, onTransactions, options).catch(reportError);
            });
            subscription.failureSignal.addEventListener("abort", () => {
              handleRecoverableFailure(subscription.failureSignal.reason ?? new Error(`HyperCore ${address} aboneliği yeniden kurulamadı.`));
            }, { once: true });
            shard.subscriptions.push(subscription);
            await wait(100);
          }
        }
        targetFingerprint = nextFingerprint;
      } catch (error) {
        await closeShards();
        handleRecoverableFailure(error);
      } finally {
        syncing = false;
      }
    };

    void replayMissedFills().catch(reportError).finally(() => void synchronizeSubscriptions());
    syncTimer = setInterval(() => void synchronizeSubscriptions(), 10_000);
    healthTimer = setInterval(() => void this.checkHealth().then(onBlock).catch(onError), 15_000);
    void this.checkHealth().then(onBlock).catch(onError);

    return () => {
      active = false;
      if (healthTimer) clearInterval(healthTimer);
      if (syncTimer) clearInterval(syncTimer);
      void closeShards();
    };
  }

  private async handleUserFills(message: UserFillsWsEvent, onTransactions: (transactions: ObservedTransaction[]) => Promise<void>, options: ChainWatchOptions) {
    if (!message.fills.length) return;
    const transactions = message.fills.map((raw) => {
      const fill = normalizeWebSocketFill(message.user, raw);
      return {
        hash: fill.id,
        from: fill.walletAddress,
        to: null,
        input: "hypercore-fill",
        blockNumber: Math.floor(fill.timestamp / 1_000),
        value: 0n,
        hypercoreFill: fill,
      } satisfies ObservedTransaction;
    });
    await onTransactions(transactions);
    options.onCursor?.(Math.max(...transactions.map((transaction) => transaction.hypercoreFill?.timestamp ?? 0)));
  }
}

function toObservedTransaction(fill: HypercoreFillObservation): ObservedTransaction {
  return {
    hash: fill.id,
    from: fill.walletAddress,
    to: null,
    input: "hypercore-fill",
    blockNumber: Math.floor(fill.timestamp / 1_000),
    value: 0n,
    hypercoreFill: fill,
  };
}

function normalizeWebSocketFill(address: string, fill: UserFillsWsEvent["fills"][number]): HypercoreFillObservation {
  const direction = fill.dir.toLowerCase();
  const priceUsd = Number(fill.px);
  const quantity = Number(fill.sz);
  return {
    id: `${fill.tid}:${fill.oid}`,
    walletAddress: address.toLowerCase(),
    coin: fill.coin,
    marketType: fill.coin.startsWith("@") || direction === "buy" || direction === "sell" ? "spot" : "perp",
    side: fill.side === "B" ? "buy" : "sell",
    direction: fill.dir,
    priceUsd,
    quantity,
    notionalUsd: priceUsd * quantity,
    feeUsd: Math.abs(Number(fill.fee)),
    closedPnlUsd: Number(fill.closedPnl),
    crossed: fill.crossed,
    sourcePositionBefore: Number(fill.startPosition),
    timestamp: fill.time,
  };
}

function toWebSocketError(error: unknown) {
  return new Error(`HyperCore WebSocket bağlantısı kurulamadı veya yeniden bağlanamadı: ${errorDetail(error)}`);
}

function errorDetail(error: unknown) {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "Bilinmeyen bağlantı hatası";
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
