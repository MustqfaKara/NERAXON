import type {
  ChainAdapter,
  ChainHealth,
  ChainWatchOptions,
  ObservedTransaction,
  SolanaTokenBalanceChange,
  SolanaTransactionObservation,
  SwapObservation,
  TransactionInspection,
} from "@/lib/chains/chain-adapter";
import { SOLANA_LAMPORTS_PER_SOL, SOLANA_QUOTE_MINTS } from "@/lib/solana/constants";
import { heliusWebSocketUrl, solanaRpc } from "@/lib/solana/helius-client";
import { recordServiceHealth, recordServiceReconnect } from "@/lib/services/service-health";
import { PublicKey } from "@solana/web3.js";
import { parseSolanaLogsNotification, type SolanaLogsNotification } from "@/lib/solana/websocket-notification";

interface TokenBalance {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string; decimals?: number };
}

interface TransactionNotification {
  slot?: number;
  signature?: string;
  transaction?: {
    transaction?: {
      signatures?: string[];
      message?: { accountKeys?: Array<string | { pubkey?: string }> };
    };
    meta?: {
      err?: unknown;
      fee?: number;
      preBalances?: number[];
      postBalances?: number[];
      preTokenBalances?: TokenBalance[];
      postTokenBalances?: TokenBalance[];
    };
  };
}

interface SolanaRpcTransaction {
  slot?: number;
  transaction?: TransactionNotification["transaction"] extends infer Wrapper
    ? Wrapper extends { transaction?: infer Transaction } ? Transaction : never
    : never;
  meta?: NonNullable<TransactionNotification["transaction"]>["meta"];
}

const SOLANA_HEALTH_INTERVAL_MS = 60_000;
const SOLANA_IDLE_CHECK_INTERVAL_MS = 60_000;
const SOLANA_IDLE_RECONNECT_MS = 8 * 60_000;

export class SolanaAdapter implements ChainAdapter {
  readonly id = "solana" as const;

  async checkHealth(): Promise<ChainHealth> {
    const startedAt = performance.now();
    const slot = await solanaRpc<number>("getSlot", [{ commitment: "confirmed" }]);
    return { blockNumber: slot, latencyMs: Math.max(1, Math.round(performance.now() - startedAt)) };
  }

  async analyzeSwap(transaction: ObservedTransaction): Promise<SwapObservation | null> {
    const observation = transaction.solanaTransaction;
    if (!observation) return null;
    const token = observation.tokenChanges
      .filter((change) => !SOLANA_QUOTE_MINTS.has(change.mint))
      .sort((left, right) => Math.abs(right.amount) - Math.abs(left.amount))[0];
    if (!token || Math.abs(token.amount) <= 0) return null;
    const quote = observation.tokenChanges
      .filter((change) => SOLANA_QUOTE_MINTS.has(change.mint))
      .sort((left, right) => Math.abs(right.amount) - Math.abs(left.amount))[0];
    return {
      txHash: observation.signature,
      side: token.amount > 0 ? "buy" : "sell",
      tokenAddress: token.mint,
      tokenSymbol: "TOKEN",
      tokenDecimals: token.decimals,
      tokenAmount: Math.abs(token.amount),
      sourceAmount: quote ? Math.abs(quote.amount) : Math.abs(observation.nativeChangeLamports) / SOLANA_LAMPORTS_PER_SOL,
    };
  }

  async inspectTransaction(transaction: ObservedTransaction): Promise<TransactionInspection> {
    const observation = transaction.solanaTransaction;
    return {
      targetAddress: null,
      selector: "solana",
      nativeValue: Math.abs(observation?.nativeChangeLamports ?? 0) / SOLANA_LAMPORTS_PER_SOL,
      gasFeeNative: (observation?.feeLamports ?? 0) / SOLANA_LAMPORTS_PER_SOL,
      tokenMovements: (observation?.tokenChanges ?? []).map((change) => ({
        tokenAddress: change.mint,
        tokenSymbol: "SPL",
        direction: change.amount >= 0 ? "in" : "out",
        amount: Math.abs(change.amount),
      })),
      likelyType: "Solana spot swap",
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
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let healthTimer: ReturnType<typeof setInterval> | null = null;
    let addressTimer: ReturnType<typeof setInterval> | null = null;
    let idleTimer: ReturnType<typeof setInterval> | null = null;
    let fingerprint = "";
    let reconnectAttempts = 0;
    let reconnectScheduled = false;
    let intentionalClose = false;
    let replaying = false;
    let lastCursor = options.resumeFromCursor ?? null;
    let lastSocketMessageAt = Date.now();
    const pendingSignatures = new Set<string>();
    const processedSignatures = new Set<string>();

    const replayMissedTransactions = async () => {
      if (lastCursor === null || replaying) return;
      replaying = true;
      const addresses = [...trackedAddresses()].filter(isValidPublicKey);
      const replay: ObservedTransaction[] = [];
      try {
        for (const address of addresses) {
          const signatures = await getMissedSignatures(address, lastCursor);
          for (const item of signatures.filter((entry) => !entry.err && entry.slot > lastCursor!).reverse()) {
            const transaction = await fetchTransaction(item.signature);
            if (!transaction) continue;
            replay.push(...parseNotification({
              slot: transaction.slot ?? item.slot,
              signature: item.signature,
              transaction: { transaction: transaction.transaction, meta: transaction.meta },
            }, new Set([address])));
          }
        }
        replay.sort((left, right) => left.blockNumber - right.blockNumber);
        for (const transaction of replay) {
          await onTransactions([transaction]);
          advanceCursor(transaction.blockNumber);
        }
      } finally {
        replaying = false;
      }
    };

    const advanceCursor = (cursor: number) => {
      lastCursor = Math.max(lastCursor ?? 0, cursor);
      options.onCursor?.(lastCursor);
    };

    const connect = () => {
      if (!active) return;
      const addresses = [...trackedAddresses()].filter(isValidPublicKey).sort();
      const nextFingerprint = addresses.join(",");
      fingerprint = nextFingerprint;
      if (!addresses.length) return;
      socket = new WebSocket(heliusWebSocketUrl());
      socket.addEventListener("open", () => {
        reconnectAttempts = 0;
        lastSocketMessageAt = Date.now();
        addresses.forEach((address, index) => {
          socket?.send(JSON.stringify({
            jsonrpc: "2.0",
            id: index + 1,
            method: "logsSubscribe",
            params: [{ mentions: [address] }, { commitment: "confirmed" }],
          }));
        });
      });
      socket.addEventListener("message", (event) => {
        lastSocketMessageAt = Date.now();
        void this.handleMessage(String(event.data), addresses, pendingSignatures, processedSignatures, onTransactions, onError, { ...options, onCursor: advanceCursor });
      });
      socket.addEventListener("error", () => socket?.close());
      socket.addEventListener("close", () => {
        socket = null;
        if (!active || reconnectScheduled) return;
        if (intentionalClose) {
          intentionalClose = false;
          connect();
          return;
        }
        reconnectAttempts += 1;
        recordServiceReconnect("solana_ws");
        reconnectScheduled = true;
        const reconnectDelay = Math.min(30_000, 1_000 * 2 ** Math.min(5, reconnectAttempts - 1));
        reconnectTimer = setTimeout(() => {
          reconnectScheduled = false;
          void replayMissedTransactions().catch(onError).finally(connect);
        }, reconnectDelay);
      });
    };

    void replayMissedTransactions().catch(onError).finally(connect);
    healthTimer = setInterval(() => { void this.checkHealth().then(onBlock).catch(onError); }, SOLANA_HEALTH_INTERVAL_MS);
    idleTimer = setInterval(() => {
      if (!socket || socket.readyState !== 1) return;
      if (Date.now() - lastSocketMessageAt > SOLANA_IDLE_RECONNECT_MS) {
        socket.close(4_000, "WebSocket bağlantısı yenileniyor");
      }
    }, SOLANA_IDLE_CHECK_INTERVAL_MS);
    addressTimer = setInterval(() => {
      const next = [...trackedAddresses()].filter(isValidPublicKey).sort().join(",");
      if (next === fingerprint) return;
      intentionalClose = true;
      socket?.close(1000, "Takip listesi güncellendi");
      if (!socket) connect();
    }, 10_000);

    return () => {
      active = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (healthTimer) clearInterval(healthTimer);
      if (addressTimer) clearInterval(addressTimer);
      if (idleTimer) clearInterval(idleTimer);
      socket?.close(1000, "Bot durduruldu");
    };
  }

  private async handleMessage(
    raw: string,
    tracked: string[],
    pendingSignatures: Set<string>,
    processedSignatures: Set<string>,
    onTransactions: (transactions: ObservedTransaction[]) => Promise<void>,
    onError: (error: Error) => Promise<void>,
    options: ChainWatchOptions,
  ) {
    try {
      const payload = JSON.parse(raw) as { id?: number; result?: number; method?: string; params?: { result?: SolanaLogsNotification }; error?: { message?: string } };
      if (payload.error) {
        await onError(new Error(`Helius WebSocket aboneliği reddedildi: ${payload.error.message ?? "Bilinmeyen abonelik hatası"}`));
        return;
      }
      if (typeof payload.result === "number" && typeof payload.id === "number") {
        recordServiceHealth("solana_ws", 0, null);
        return;
      }
      if (payload.method !== "logsNotification" || !payload.params?.result) return;
      const notification = parseSolanaLogsNotification(payload.params.result);
      if (!notification || pendingSignatures.has(notification.signature) || processedSignatures.has(notification.signature)) return;
      pendingSignatures.add(notification.signature);
      try {
        const transaction = await fetchTransaction(notification.signature);
        if (!transaction) return;
        const transactions = parseNotification({
          slot: transaction.slot ?? notification.slot,
          signature: notification.signature,
          transaction: { transaction: transaction.transaction, meta: transaction.meta },
        }, new Set(tracked));
        processedSignatures.add(notification.signature);
        trimSignatureCache(processedSignatures);
        if (transactions.length) {
          await onTransactions(transactions);
          options.onCursor?.(Math.max(...transactions.map((item) => item.blockNumber)));
        }
      } catch (error) {
        recordServiceHealth("helius", 0, error instanceof Error ? error.message : "Solana işlem ayrıntısı alınamadı.");
      } finally {
        pendingSignatures.delete(notification.signature);
      }
    } catch (error) {
      await onError(error instanceof Error ? error : new Error("Solana işlem bildirimi ayrıştırılamadı."));
    }
  }
}

async function getMissedSignatures(address: string, cursor: number) {
  const collected: Array<{ signature: string; slot: number; err?: unknown }> = [];
  let before: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const batch = await solanaRpc<Array<{ signature: string; slot: number; err?: unknown }>>("getSignaturesForAddress", [
      address,
      { limit: 100, commitment: "confirmed", ...(before ? { before } : {}) },
    ]);
    collected.push(...batch);
    if (batch.length < 100 || batch.some((item) => item.slot <= cursor)) break;
    before = batch.at(-1)?.signature;
    if (!before) break;
  }
  return collected.filter((item) => item.slot > cursor);
}

async function fetchTransaction(signature: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const transaction = await solanaRpc<SolanaRpcTransaction | null>("getTransaction", [
      signature,
      { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
    ]);
    if (transaction) return transaction;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
  }
  return null;
}

function trimSignatureCache(signatures: Set<string>) {
  while (signatures.size > 2_000) {
    const oldest = signatures.values().next().value;
    if (!oldest) return;
    signatures.delete(oldest);
  }
}

function isValidPublicKey(address: string) {
  try {
    return new PublicKey(address).toBase58() === address;
  } catch {
    return false;
  }
}

function parseNotification(notification: TransactionNotification, tracked: Set<string>): ObservedTransaction[] {
  const wrapper = notification.transaction;
  const transaction = wrapper?.transaction;
  const meta = wrapper?.meta;
  if (!transaction || !meta || meta.err) return [];
  const accountKeys = (transaction.message?.accountKeys ?? []).map((key) => typeof key === "string" ? key : key.pubkey ?? "");
  const signature = notification.signature ?? transaction.signatures?.[0];
  if (!signature) return [];
  const results: ObservedTransaction[] = [];
  for (const address of tracked) {
    const accountIndex = accountKeys.indexOf(address);
    const ownsTokenBalance = [...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])].some((balance) => balance.owner === address);
    if (accountIndex < 0 && !ownsTokenBalance) continue;
    const tokenChanges = calculateTokenChanges(address, meta.preTokenBalances ?? [], meta.postTokenBalances ?? []);
    if (!tokenChanges.some((change) => Math.abs(change.amount) > 0)) continue;
    const nativeChangeLamports = accountIndex >= 0
      ? Number(meta.postBalances?.[accountIndex] ?? 0) - Number(meta.preBalances?.[accountIndex] ?? 0)
      : 0;
    const solanaTransaction: SolanaTransactionObservation = {
      signature,
      slot: notification.slot ?? 0,
      feeLamports: meta.fee ?? 0,
      nativeChangeLamports,
      tokenChanges,
    };
    results.push({ hash: signature, from: address, to: null, input: "solana:swap", blockNumber: solanaTransaction.slot, value: 0n, solanaTransaction });
  }
  return results;
}

function calculateTokenChanges(owner: string, pre: TokenBalance[], post: TokenBalance[]): SolanaTokenBalanceChange[] {
  const balances = new Map<string, { mint: string; owner: string; decimals: number; before: bigint; after: bigint }>();
  const apply = (items: TokenBalance[], side: "before" | "after") => {
    for (const item of items) {
      if (item.owner !== owner || !item.mint) continue;
      const key = `${item.accountIndex ?? -1}:${item.mint}`;
      const current = balances.get(key) ?? { mint: item.mint, owner, decimals: item.uiTokenAmount?.decimals ?? 0, before: 0n, after: 0n };
      current[side] = BigInt(item.uiTokenAmount?.amount ?? "0");
      current.decimals = item.uiTokenAmount?.decimals ?? current.decimals;
      balances.set(key, current);
    }
  };
  apply(pre, "before");
  apply(post, "after");
  return [...balances.values()].map((item) => ({
    mint: item.mint,
    owner: item.owner,
    decimals: item.decimals,
    amount: Number(item.after - item.before) / 10 ** item.decimals,
  })).filter((item) => Number.isFinite(item.amount) && item.amount !== 0);
}
