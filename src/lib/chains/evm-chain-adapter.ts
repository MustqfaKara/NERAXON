import { formatUnits, type Hash, type TransactionReceipt } from "viem";
import type { EvmChainId } from "@/lib/domain/types";
import type { ChainAdapter, ChainHealth, ChainWatchOptions, ObservedTransaction, SwapObservation, TransactionInspection } from "@/lib/chains/chain-adapter";
import { getPublicClient } from "@/lib/chains/public-client";
import { getQuoteTokenKind, isQuoteToken } from "@/lib/chains/token-config";
import { parseErc20TransferAmount } from "@/lib/chains/evm-log";
import { getEvmReplayBatchSize, splitEvmReplayRange } from "@/lib/chains/evm-replay";
import { evmPollingIntervalMs, fetchEvmRpcJson } from "@/lib/chains/evm-rpc-pool";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MAX_REPLAY_BLOCKS = 20_000;
const ERC20_METADATA_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

export class EvmChainAdapter implements ChainAdapter {
  readonly id: EvmChainId;
  private readonly client;
  private readonly receiptCache = new Map<string, { expiresAt: number; value: Promise<TransactionReceipt> }>();
  private lastHealth: ChainHealth | null = null;
  private lastHealthCheckedAt = 0;

  constructor(id: EvmChainId) {
    this.id = id;
    this.client = getPublicClient(id);
  }

  async checkHealth(): Promise<ChainHealth> {
    const startedAt = performance.now();
    const payload = await fetchEvmRpcJson<{ result?: string; error?: { message?: string } }>(
      this.id,
      { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
      10_000,
    );
    if (!payload.result) throw new Error(payload.error?.message ?? "RPC blok numarası döndürmedi.");
    const health = {
      blockNumber: Number(BigInt(payload.result)),
      latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
    };
    this.lastHealth = health;
    this.lastHealthCheckedAt = Date.now();
    return health;
  }

  async analyzeSwap(transaction: ObservedTransaction): Promise<SwapObservation | null> {
    const receipt = await this.getReceipt(transaction.hash);
    const walletAddress = transaction.from.toLowerCase();
    const incoming = new Map<string, bigint>();
    const outgoing = new Map<string, bigint>();

    for (const log of receipt.logs) {
      if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length < 3) continue;
      const from = topicAddress(log.topics[1]);
      const to = topicAddress(log.topics[2]);
      const amount = parseErc20TransferAmount(log.data);
      const tokenAddress = log.address.toLowerCase();
      if (to === walletAddress) incoming.set(tokenAddress, (incoming.get(tokenAddress) ?? 0n) + amount);
      if (from === walletAddress) outgoing.set(tokenAddress, (outgoing.get(tokenAddress) ?? 0n) + amount);
    }

    const incomingTarget = [...incoming.entries()].find(([address]) => !isQuoteToken(this.id, address));
    const outgoingTarget = [...outgoing.entries()].find(([address]) => !isQuoteToken(this.id, address));
    const incomingStable = [...incoming.entries()].find(([address]) => getQuoteTokenKind(this.id, address) === "stable");
    const outgoingStable = [...outgoing.entries()].find(([address]) => getQuoteTokenKind(this.id, address) === "stable");
    const side = incomingTarget ? "buy" : outgoingTarget ? "sell" : incomingStable ? "buy" : outgoingStable ? "sell" : null;
    const target = incomingTarget ?? outgoingTarget ?? incomingStable ?? outgoingStable;
    if (!side || !target) return null;

    const [tokenAddress, rawAmount] = target;
    const metadata = await this.getTokenMetadata(tokenAddress).catch(() => null);
    if (!metadata) return null;
    const quoteMovement = side === "buy"
      ? [...outgoing.entries()].find(([address]) => isQuoteToken(this.id, address))
      : [...incoming.entries()].find(([address]) => isQuoteToken(this.id, address));
    const sourceAmount = quoteMovement ? await this.formatTokenAmount(quoteMovement[0], quoteMovement[1]) : null;

    return {
      txHash: transaction.hash,
      side,
      tokenAddress,
      tokenSymbol: metadata.symbol,
      tokenDecimals: metadata.decimals,
      tokenAmount: Number(formatUnits(rawAmount, metadata.decimals)),
      sourceAmount: transaction.value > 0n && side === "buy"
        ? Number(formatUnits(transaction.value, 18))
        : sourceAmount,
    };
  }

  async inspectTransaction(transaction: ObservedTransaction): Promise<TransactionInspection> {
    const receipt = await this.getReceipt(transaction.hash);
    const walletAddress = transaction.from.toLowerCase();
    const rawMovements = new Map<string, { tokenAddress: string; direction: "in" | "out"; amount: bigint }>();
    for (const log of receipt.logs) {
      if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length < 3) continue;
      const from = topicAddress(log.topics[1]);
      const to = topicAddress(log.topics[2]);
      const direction = to === walletAddress ? "in" : from === walletAddress ? "out" : null;
      if (!direction) continue;
      const tokenAddress = log.address.toLowerCase();
      const key = `${tokenAddress}:${direction}`;
      const current = rawMovements.get(key);
      rawMovements.set(key, { tokenAddress, direction, amount: (current?.amount ?? 0n) + parseErc20TransferAmount(log.data) });
    }
    const tokenMovements = (await Promise.all([...rawMovements.values()].map(async (movement) => {
      try {
        const metadata = await this.getTokenMetadata(movement.tokenAddress);
        return {
          tokenAddress: movement.tokenAddress,
          tokenSymbol: metadata.symbol,
          direction: movement.direction,
          amount: Number(formatUnits(movement.amount, metadata.decimals)),
        };
      } catch {
        return {
          tokenAddress: movement.tokenAddress,
          tokenSymbol: "TOKEN",
          direction: movement.direction,
          amount: Number(movement.amount),
        };
      }
    }))).slice(0, 8);
    const hasIncoming = tokenMovements.some((movement) => movement.direction === "in");
    const hasOutgoing = tokenMovements.some((movement) => movement.direction === "out");
    return {
      targetAddress: transaction.to,
      selector: transaction.input.slice(0, 10).toLowerCase(),
      nativeValue: Number(formatUnits(transaction.value, 18)),
      gasFeeNative: Number(formatUnits(receipt.gasUsed * receipt.effectiveGasPrice, 18)),
      tokenMovements,
      likelyType: hasIncoming && hasOutgoing
        ? "Özel router veya aggregator işlemi"
        : tokenMovements.length ? "Token transferi içeren kontrat çağrısı" : "Bilinmeyen kontrat çağrısı",
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
    let lastBlock = options.resumeFromCursor === null || options.resumeFromCursor === undefined
      ? null
      : BigInt(options.resumeFromCursor);
    let processing = Promise.resolve();
    const stopWatching = this.client.watchBlockNumber({
      emitOnBegin: true,
      pollingInterval: evmPollingIntervalMs(this.id),
      onBlockNumber: async (blockNumber) => {
        processing = processing.then(async () => {
          if (!active) return;
          if (lastBlock !== null && blockNumber <= lastBlock) return;
          const start = lastBlock === null
            ? blockNumber
            : blockNumber - lastBlock > BigInt(MAX_REPLAY_BLOCKS)
              ? blockNumber - BigInt(MAX_REPLAY_BLOCKS) + 1n
              : lastBlock + 1n;
          const health = Date.now() - this.lastHealthCheckedAt >= 60_000
            ? await this.checkHealth()
            : { blockNumber: Number(blockNumber), latencyMs: this.lastHealth?.latencyMs ?? 1 };
          await onBlock({ ...health, blockNumber: Number(blockNumber) });
          const replayBatchSize = getEvmReplayBatchSize(this.id);
          for (const range of splitEvmReplayRange(start, blockNumber, replayBatchSize)) {
            if (!active) return;
            const { fromBlock: cursor, toBlock: end } = range;
            const addresses = trackedAddresses();
            const matches = addresses.size
              ? await this.getTrackedTransactions(cursor, end, addresses)
              : [];
            if (matches.length) await onTransactions(matches);
            lastBlock = end;
            options.onCursor?.(Number(end));
            if ((this.id === "base" || this.id === "robinhood") && end < blockNumber) {
              await new Promise((resolve) => setTimeout(resolve, this.id === "base" ? 75 : 125));
            }
          }
        }).catch((error) => active ? onError(error instanceof Error ? error : new Error("EVM blok replay hatası.")) : undefined);
        await processing;
      },
      onError: (error) => {
        if (active) void onError(error instanceof Error ? error : new Error("RPC izleme hatası."));
      },
    });
    return () => {
      active = false;
      stopWatching();
    };
  }

  private async getTrackedTransactions(from: bigint, to: bigint, addresses: Set<string>) {
    const addressTopics = [...addresses].map((address) => `0x${address.slice(2).padStart(64, "0")}`);
    const range = { fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` };
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ ...range, topics: [TRANSFER_TOPIC, addressTopics] }] },
      { jsonrpc: "2.0", id: 2, method: "eth_getLogs", params: [{ ...range, topics: [TRANSFER_TOPIC, null, addressTopics] }] },
    ];
    const payload = await this.fetchRpcBatch<Array<{ transactionHash: Hash }>>(requests);
    const hashes = [...new Set(payload.flatMap((item) => item.result ?? []).map((log) => log.transactionHash))];
    const transactions = await Promise.all(hashes.map((hash) => this.client.getTransaction({ hash })));
    return transactions
      .filter((transaction) => addresses.has(transaction.from.toLowerCase()))
      .map((transaction) => ({
        hash: transaction.hash,
        from: transaction.from.toLowerCase(),
        to: transaction.to?.toLowerCase() ?? null,
        input: transaction.input,
        blockNumber: Number(transaction.blockNumber),
        value: transaction.value,
      } satisfies ObservedTransaction));
  }

  private async fetchRpcBatch<T>(requests: Array<Record<string, unknown>>) {
    return fetchEvmRpcJson<Array<{ id: number; result?: T; error?: { message?: string } }>>(
      this.id,
      requests,
      20_000,
    );
  }

  private async getTokenMetadata(tokenAddress: string) {
    const address = tokenAddress as `0x${string}`;
    const [symbol, decimals] = await Promise.all([
      this.client.readContract({ address, abi: ERC20_METADATA_ABI, functionName: "symbol" }),
      this.client.readContract({ address, abi: ERC20_METADATA_ABI, functionName: "decimals" }),
    ]);
    return { symbol, decimals };
  }

  private async formatTokenAmount(tokenAddress: string, rawAmount: bigint) {
    try {
      const metadata = await this.getTokenMetadata(tokenAddress);
      return Number(formatUnits(rawAmount, metadata.decimals));
    } catch {
      return null;
    }
  }

  private getReceipt(transactionHash: string): Promise<TransactionReceipt> {
    const now = Date.now();
    const cached = this.receiptCache.get(transactionHash);
    if (cached && cached.expiresAt > now) return cached.value;
    for (const [hash, entry] of this.receiptCache) {
      if (entry.expiresAt <= now) this.receiptCache.delete(hash);
    }
    const value = this.client.getTransactionReceipt({ hash: transactionHash as Hash });
    this.receiptCache.set(transactionHash, { expiresAt: now + 30_000, value });
    return value;
  }
}

function topicAddress(topic: string | undefined): string {
  if (!topic) return "";
  return `0x${topic.slice(-40)}`.toLowerCase();
}
