import { formatUnits, type Hash, type TransactionReceipt } from "viem";
import type { ChainId } from "@/lib/domain/types";
import type { ChainAdapter, ChainHealth, ObservedTransaction, SwapObservation, TransactionInspection } from "@/lib/chains/chain-adapter";
import { getPublicClient } from "@/lib/chains/public-client";
import { isQuoteToken } from "@/lib/chains/token-config";
import { CHAIN_DEFINITIONS } from "@/lib/domain/defaults";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ERC20_METADATA_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

export class EvmChainAdapter implements ChainAdapter {
  readonly id: ChainId;
  private readonly client;
  private readonly receiptCache = new Map<string, { expiresAt: number; value: Promise<TransactionReceipt> }>();

  constructor(id: ChainId) {
    this.id = id;
    this.client = getPublicClient(id);
  }

  async checkHealth(): Promise<ChainHealth> {
    const startedAt = performance.now();
    const response = await fetch(CHAIN_DEFINITIONS[this.id].rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`RPC sağlık kontrolü başarısız (${response.status}).`);
    const payload = await response.json() as { result?: string; error?: { message?: string } };
    if (!payload.result) throw new Error(payload.error?.message ?? "RPC blok numarası döndürmedi.");
    return {
      blockNumber: Number(BigInt(payload.result)),
      latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
    };
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
      const amount = BigInt(log.data || "0x0");
      const tokenAddress = log.address.toLowerCase();
      if (to === walletAddress) incoming.set(tokenAddress, (incoming.get(tokenAddress) ?? 0n) + amount);
      if (from === walletAddress) outgoing.set(tokenAddress, (outgoing.get(tokenAddress) ?? 0n) + amount);
    }

    const incomingTarget = [...incoming.entries()].find(([address]) => !isQuoteToken(this.id, address));
    const outgoingTarget = [...outgoing.entries()].find(([address]) => !isQuoteToken(this.id, address));
    const side = incomingTarget ? "buy" : outgoingTarget ? "sell" : null;
    const target = incomingTarget ?? outgoingTarget;
    if (!side || !target) return null;

    const [tokenAddress, rawAmount] = target;
    const metadata = await this.getTokenMetadata(tokenAddress);
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
      rawMovements.set(key, { tokenAddress, direction, amount: (current?.amount ?? 0n) + BigInt(log.data || "0x0") });
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
  ) {
    let lastBlock: bigint | null = null;
    return this.client.watchBlockNumber({
      emitOnBegin: true,
      pollingInterval: this.id === "base" ? 3_000 : 12_000,
      onBlockNumber: async (blockNumber) => {
        if (lastBlock === blockNumber) return;
        lastBlock = blockNumber;
        const health = await this.checkHealth();
        await onBlock(health);

        const addresses = trackedAddresses();
        if (addresses.size === 0) return;
        const block = await this.client.getBlock({ blockNumber, includeTransactions: true });
        const matches: ObservedTransaction[] = [];
        for (const transaction of block.transactions) {
          if (typeof transaction === "string") continue;
          if (!addresses.has(transaction.from.toLowerCase())) continue;
          matches.push({
            hash: transaction.hash as Hash,
            from: transaction.from.toLowerCase(),
            to: transaction.to?.toLowerCase() ?? null,
            input: transaction.input,
            blockNumber: Number(blockNumber),
            value: transaction.value,
          });
        }
        if (matches.length) await onTransactions(matches);
      },
      onError: (error) => void onError(error instanceof Error ? error : new Error("RPC izleme hatası.")),
    });
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
