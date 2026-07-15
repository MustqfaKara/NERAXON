import { getPublicClient } from "@/lib/chains/public-client";
import { isQuoteToken } from "@/lib/chains/token-config";
import { CHAIN_DEFINITIONS } from "@/lib/domain/defaults";
import type {
  ChainId,
  DiscoveryGainerToken,
  DiscoveryTokenPerformance,
  WalletDiscoveryCandidate,
  WalletDiscoveryScan,
} from "@/lib/domain/types";
import { calculateDiscoveryScore } from "@/lib/engine/discovery-scoring";
import { calculateMarkToMarketPnl, isDiscoveryTokenPerformanceEligible } from "@/lib/engine/discovery-pnl";
import { estimatePaperGas } from "@/lib/services/gas-estimator";
import { getMarketDataProvider, type MarketSnapshot } from "@/lib/services/market-data-provider";

const DISCOVERY_UNIVERSE_TRANSFER_LIMIT = 5_000;
const DISCOVERY_UNIVERSE_TOKEN_LIMIT = 150;
const TRANSFER_PAGE_SIZE = 1_000;
const MAX_TOKEN_TRANSFER_PAGES = 100;
const TOP_GAINER_LIMIT = 10;
const MIN_GAINER_LIQUIDITY_USD = 10_000;
const RPC_MAX_ATTEMPTS = 5;
const DISCOVERY_CACHE_TTL_MS = 5 * 60_000;
const BLOCKS_PER_DAY: Record<ChainId, number> = { ethereum: 7_200, base: 43_200 };
const PUBLIC_DISCOVERY_RPC: Record<ChainId, string> = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  base: "https://mainnet.base.org",
};

interface AlchemyTransfer {
  hash: string;
  from: string | null;
  to: string | null;
  value?: number | null;
  rawContract?: { address?: string | null };
  metadata?: { blockTimestamp?: string };
}

interface TransferPage {
  transfers: AlchemyTransfer[];
  pageKey?: string;
}

interface UnifiedTransfer {
  hash: string;
  from: string;
  to: string;
  tokenAddress: string;
  value: number;
  timestamp: string;
}

interface TokenFlow {
  market: DiscoveryGainerToken;
  boughtUsd: number;
  soldUsd: number;
  netTokenAmount: number;
  gasCostUsd: number;
  buyCount: number;
  sellCount: number;
  hashes: Set<string>;
}

interface WalletAccumulator {
  address: string;
  flows: Map<string, TokenFlow>;
  lastActiveAt: string;
}

export interface WalletDiscoveryProvider {
  scan(chainId: ChainId): Promise<WalletDiscoveryScan>;
}

export class HybridWalletDiscoveryProvider implements WalletDiscoveryProvider {
  private readonly cache = new Map<ChainId, { expiresAt: number; scan: WalletDiscoveryScan }>();

  async scan(chainId: ChainId): Promise<WalletDiscoveryScan> {
    const cached = this.cache.get(chainId);
    if (cached && cached.expiresAt > Date.now()) return cached.scan;
    const latestBlock = Number(await getPublicClient(chainId).getBlockNumber());
    const fromBlock = Math.max(0, latestBlock - BLOCKS_PER_DAY[chainId]);
    const windowStartedAt = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
    const universe = await getAlchemyTransfers(chainId, fromBlock, { limit: DISCOVERY_UNIVERSE_TRANSFER_LIMIT });
    const marketProvider = getMarketDataProvider();
    const topGainers = await discoverTopGainers(chainId, universe.transfers);
    if (!topGainers.length) return emptyScan(chainId, windowStartedAt, universe.transfers.length);

    const tokenAddresses = topGainers.map((token) => token.address);
    const [focused, poolAddresses, gasEstimate] = await Promise.all([
      getAlchemyTransfers(chainId, fromBlock, { contractAddresses: tokenAddresses, maxPages: MAX_TOKEN_TRANSFER_PAGES }),
      marketProvider.getTokenPoolAddresses(chainId, tokenAddresses),
      estimatePaperGas(chainId),
    ]);
    const transfers = focused.transfers
      .map(toUnifiedAlchemyTransfer)
      .filter((transfer): transfer is UnifiedTransfer => Boolean(transfer));
    const groupedTransfers = groupTransfers(transfers);
    const analyzedCandidates = analyzeTransferGraph(
      chainId,
      groupedTransfers,
      new Map(topGainers.map((token) => [token.address, token])),
      poolAddresses,
      gasEstimate.feeUsd,
    );
    const candidates = await filterExternallyOwnedAccounts(chainId, analyzedCandidates);

    const scan: WalletDiscoveryScan = {
      chainId,
      candidates,
      transferSampleSize: transfers.length,
      transactionSampleSize: groupedTransfers.size,
      topGainers,
      pnlDataSource: "alchemy+dexscreener",
      windowStartedAt,
      generatedAt: new Date().toISOString(),
    };
    this.cache.set(chainId, { expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS, scan });
    return scan;
  }
}

async function filterExternallyOwnedAccounts(chainId: ChainId, candidates: WalletDiscoveryCandidate[]) {
  const contracts = new Set<string>();
  for (let index = 0; index < candidates.length; index += 2) {
    const chunk = candidates.slice(index, index + 2);
    const payload = await getCodeBatch(chainId, chunk);
    const byId = new Map(payload.map((item) => [item.id, item]));
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const item = byId.get(offset + 1);
      if (item?.error || typeof item?.result !== "string") throw new Error(item?.error?.message ?? "EOA doğrulama verisi dönmedi.");
      if (item.result !== "0x") contracts.add(chunk[offset].address);
    }
    await delay(500);
  }
  return candidates.filter((candidate) => !contracts.has(candidate.address));
}

async function getCodeBatch(chainId: ChainId, candidates: WalletDiscoveryCandidate[]) {
  for (let attempt = 0; attempt < RPC_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(PUBLIC_DISCOVERY_RPC[chainId], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(candidates.map((candidate, offset) => ({
        jsonrpc: "2.0",
        id: offset + 1,
        method: "eth_getCode",
        params: [candidate.address, "latest"],
      }))),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json() as Array<{ id: number; result?: string; error?: { message?: string } }> | { error?: { message?: string } };
    const rateLimited = response.status === 429
      || (!Array.isArray(payload) && /rate limit/i.test(payload.error?.message ?? ""))
      || (Array.isArray(payload) && payload.some((item) => /rate limit/i.test(item.error?.message ?? "")));
    if (rateLimited && attempt < RPC_MAX_ATTEMPTS - 1) {
      await delay(750 * 2 ** attempt);
      continue;
    }
    if (!response.ok) throw new Error(`EOA doğrulaması başarısız (${response.status}).`);
    if (!Array.isArray(payload)) throw new Error(payload.error?.message ?? "EOA doğrulama batch yanıtı geçersiz.");
    return payload;
  }
  throw new Error("EOA doğrulaması hız sınırı nedeniyle tamamlanamadı.");
}

async function discoverTopGainers(chainId: ChainId, transfers: AlchemyTransfer[]): Promise<DiscoveryGainerToken[]> {
  const frequency = new Map<string, number>();
  for (const transfer of transfers) {
    const tokenAddress = transfer.rawContract?.address?.toLowerCase();
    if (!tokenAddress || isQuoteToken(chainId, tokenAddress)) continue;
    frequency.set(tokenAddress, (frequency.get(tokenAddress) ?? 0) + 1);
  }
  const addresses = [...frequency.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, DISCOVERY_UNIVERSE_TOKEN_LIMIT)
    .map(([address]) => address);
  const markets = await getMarketDataProvider().getTokenMarkets(chainId, addresses);
  return markets
    .filter((market) => market.priceChange24hPercent > 0 && market.priceChange24hPercent <= 1_000)
    .filter((market) => market.liquidityUsd >= MIN_GAINER_LIQUIDITY_USD)
    .sort((left, right) => right.priceChange24hPercent - left.priceChange24hPercent)
    .slice(0, TOP_GAINER_LIMIT)
    .map(toGainerToken);
}

function analyzeTransferGraph(
  chainId: ChainId,
  groupedTransfers: Map<string, UnifiedTransfer[]>,
  markets: Map<string, DiscoveryGainerToken>,
  poolAddresses: Record<string, string[]>,
  estimatedGasPerSwapUsd: number,
) {
  const wallets = new Map<string, WalletAccumulator>();
  const allPools = new Set(Object.values(poolAddresses).flat());
  allPools.add("0x0000000000000000000000000000000000000000");

  for (const [hash, transfers] of groupedTransfers) {
    for (const market of markets.values()) {
      const tokenTransfers = transfers.filter((transfer) => transfer.tokenAddress === market.address);
      if (!tokenTransfers.length) continue;
      const tokenPools = new Set(poolAddresses[market.address] ?? []);
      const connectedToPool = tokenTransfers.some((transfer) => tokenPools.has(transfer.from) || tokenPools.has(transfer.to));
      if (!connectedToPool) continue;
      const addresses = new Set(tokenTransfers.flatMap((transfer) => [transfer.from, transfer.to]).filter(Boolean));
      for (const address of addresses) {
        if (allPools.has(address)) continue;
        const incoming = sumTransferValue(tokenTransfers, market.address, address, "in");
        const outgoing = sumTransferValue(tokenTransfers, market.address, address, "out");
        const netAmount = incoming - outgoing;
        if (netAmount === 0) continue;
        const timestamp = newestTimestamp(tokenTransfers);
        const wallet = wallets.get(address) ?? { address, flows: new Map<string, TokenFlow>(), lastActiveAt: timestamp };
        const flow = wallet.flows.get(market.address) ?? createTokenFlow(market);
        if (netAmount > 0) {
          flow.boughtUsd += netAmount * estimateEntryPrice(market, timestamp);
          flow.netTokenAmount += netAmount;
          flow.buyCount += 1;
        } else {
          flow.soldUsd += Math.abs(netAmount) * market.priceUsd;
          flow.netTokenAmount += netAmount;
          flow.sellCount += 1;
        }
        flow.gasCostUsd += estimatedGasPerSwapUsd;
        flow.hashes.add(hash);
        wallet.flows.set(market.address, flow);
        if (timestamp > wallet.lastActiveAt) wallet.lastActiveAt = timestamp;
        wallets.set(address, wallet);
      }
    }
  }

  return [...wallets.values()]
    .map((wallet) => finalizeCandidate(chainId, wallet))
    .filter((candidate): candidate is WalletDiscoveryCandidate => Boolean(candidate))
    .sort((left, right) => right.estimatedPnlUsd - left.estimatedPnlUsd || right.score - left.score);
}

function finalizeCandidate(chainId: ChainId, wallet: WalletAccumulator): WalletDiscoveryCandidate | null {
  const gainerTokens: DiscoveryTokenPerformance[] = [...wallet.flows.values()].map((flow) => {
    const currentValueUsd = Math.max(0, flow.netTokenAmount) * flow.market.priceUsd;
    return {
      ...flow.market,
      boughtUsd: flow.boughtUsd,
      soldUsd: flow.soldUsd,
      currentValueUsd,
      estimatedPnlUsd: flow.soldUsd + currentValueUsd - flow.boughtUsd - flow.gasCostUsd,
      gasCostUsd: flow.gasCostUsd,
      swapCount: flow.hashes.size,
      buyCount: flow.buyCount,
      sellCount: flow.sellCount,
    };
  }).filter(isDiscoveryTokenPerformanceEligible);
  if (!gainerTokens.length) return null;

  const boughtUsd = sum(gainerTokens.map((token) => token.boughtUsd));
  const soldUsd = sum(gainerTokens.map((token) => token.soldUsd));
  const currentValueUsd = sum(gainerTokens.map((token) => token.currentValueUsd));
  const gasCostUsd = sum(gainerTokens.map((token) => token.gasCostUsd));
  const estimatedPnlUsd = soldUsd + currentValueUsd - boughtUsd - gasCostUsd;
  const { estimatedPnlPercent } = calculateMarkToMarketPnl(boughtUsd, soldUsd - gasCostUsd, currentValueUsd);
  const swapHashes = new Set(gainerTokens.flatMap((token) => [...(wallet.flows.get(token.address)?.hashes ?? [])]));
  const buyCount = sum(gainerTokens.map((token) => token.buyCount));
  const sellCount = sum(gainerTokens.map((token) => token.sellCount));
  const scoring = calculateDiscoveryScore({
    swapCount: swapHashes.size,
    buyCount,
    sellCount,
    uniqueTokenCount: gainerTokens.length,
    ageMinutes: Math.max(0, (Date.now() - new Date(wallet.lastActiveAt).getTime()) / 60_000),
    estimatedPnlPercent,
  });
  return {
    address: wallet.address,
    chainId,
    score: scoring.score,
    scoreBreakdown: scoring.breakdown,
    swapCount: swapHashes.size,
    buyCount,
    sellCount,
    uniqueTokenCount: gainerTokens.length,
    boughtUsd,
    soldUsd,
    currentValueUsd,
    estimatedPnlUsd,
    estimatedPnlPercent,
    gasCostUsd,
    gainerTokens: gainerTokens.sort((left, right) => right.estimatedPnlUsd - left.estimatedPnlUsd),
    lastActiveAt: wallet.lastActiveAt,
    sampleTxHashes: [...swapHashes].slice(0, 3),
  };
}

async function getAlchemyTransfers(
  chainId: ChainId,
  fromBlock: number,
  options: { contractAddresses?: string[]; limit?: number; maxPages?: number },
) {
  const transfers: AlchemyTransfer[] = [];
  let pageKey: string | undefined;
  let page = 0;
  do {
    const result = await alchemyRequest<TransferPage>(chainId, "alchemy_getAssetTransfers", [{
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: "latest",
      category: ["erc20"],
      maxCount: `0x${TRANSFER_PAGE_SIZE.toString(16)}`,
      order: "asc",
      withMetadata: true,
      excludeZeroValue: true,
      ...(options.contractAddresses?.length ? { contractAddresses: options.contractAddresses } : {}),
      ...(pageKey ? { pageKey } : {}),
    }]);
    transfers.push(...result.transfers);
    pageKey = result.pageKey;
    page += 1;
    if (options.limit && transfers.length >= options.limit) break;
  } while (pageKey && page < (options.maxPages ?? Number.POSITIVE_INFINITY));
  return { transfers: options.limit ? transfers.slice(0, options.limit) : transfers, truncated: Boolean(pageKey) };
}

async function alchemyRequest<T>(chainId: ChainId, method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; attempt < RPC_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(CHAIN_DEFINITIONS[chainId].rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 429 && attempt < RPC_MAX_ATTEMPTS - 1) {
      await delay(500 * 2 ** attempt);
      continue;
    }
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Alchemy keşif sorgusu başarısız (${response.status}): ${detail.slice(0, 240)}`);
    }
    const payload = await response.json() as { result?: T; error?: { message?: string } };
    if (payload.error || payload.result === undefined) throw new Error(payload.error?.message ?? "Alchemy keşif verisi dönmedi.");
    return payload.result;
  }
  throw new Error("Alchemy keşif sorgusu hız sınırı nedeniyle tamamlanamadı.");
}

function createTokenFlow(market: DiscoveryGainerToken): TokenFlow {
  return { market, boughtUsd: 0, soldUsd: 0, netTokenAmount: 0, gasCostUsd: 0, buyCount: 0, sellCount: 0, hashes: new Set<string>() };
}

function toUnifiedAlchemyTransfer(transfer: AlchemyTransfer): UnifiedTransfer | null {
  const tokenAddress = transfer.rawContract?.address?.toLowerCase();
  if (!tokenAddress || !transfer.hash || !Number.isFinite(Number(transfer.value))) return null;
  return {
    hash: transfer.hash.toLowerCase(),
    from: transfer.from?.toLowerCase() ?? "",
    to: transfer.to?.toLowerCase() ?? "",
    tokenAddress,
    value: Number(transfer.value ?? 0),
    timestamp: transfer.metadata?.blockTimestamp ?? new Date().toISOString(),
  };
}

function toGainerToken(market: MarketSnapshot): DiscoveryGainerToken {
  return {
    address: market.tokenAddress,
    symbol: market.tokenSymbol,
    priceUsd: market.priceUsd,
    priceChange24hPercent: market.priceChange24hPercent,
    liquidityUsd: market.liquidityUsd,
    volume24hUsd: market.volume24hUsd,
    marketCapUsd: market.marketCapUsd,
    pairAddress: market.pairAddress,
    dexId: market.dexId,
  };
}

function groupTransfers(transfers: UnifiedTransfer[]) {
  const grouped = new Map<string, UnifiedTransfer[]>();
  for (const transfer of transfers) grouped.set(transfer.hash, [...(grouped.get(transfer.hash) ?? []), transfer]);
  return grouped;
}

function sumTransferValue(transfers: UnifiedTransfer[], tokenAddress: string, walletAddress: string, direction: "in" | "out") {
  return sum(transfers
    .filter((transfer) => transfer.tokenAddress === tokenAddress && (direction === "in" ? transfer.to === walletAddress : transfer.from === walletAddress))
    .map((transfer) => transfer.value));
}

function estimateEntryPrice(market: DiscoveryGainerToken, timestamp: string) {
  const ageFraction = Math.min(1, Math.max(0, (Date.now() - new Date(timestamp).getTime()) / (24 * 60 * 60 * 1_000)));
  return market.priceUsd / Math.max(0.01, 1 + market.priceChange24hPercent * ageFraction / 100);
}

function newestTimestamp(transfers: UnifiedTransfer[]) {
  return transfers.reduce((latest, transfer) => transfer.timestamp > latest ? transfer.timestamp : latest, transfers[0]?.timestamp ?? new Date().toISOString());
}

function emptyScan(chainId: ChainId, windowStartedAt: string, transferSampleSize: number): WalletDiscoveryScan {
  return {
    chainId,
    candidates: [],
    transferSampleSize,
    transactionSampleSize: 0,
    topGainers: [],
    pnlDataSource: "alchemy+dexscreener",
    windowStartedAt,
    generatedAt: new Date().toISOString(),
  };
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const DISCOVERY_PROVIDER_VERSION = 15;
const globalDiscovery = globalThis as typeof globalThis & {
  copydeskDiscoveryProvider?: WalletDiscoveryProvider;
  copydeskDiscoveryProviderVersion?: number;
};
export const getWalletDiscoveryProvider = () => {
  if (!globalDiscovery.copydeskDiscoveryProvider || globalDiscovery.copydeskDiscoveryProviderVersion !== DISCOVERY_PROVIDER_VERSION) {
    globalDiscovery.copydeskDiscoveryProvider = new HybridWalletDiscoveryProvider();
    globalDiscovery.copydeskDiscoveryProviderVersion = DISCOVERY_PROVIDER_VERSION;
  }
  return globalDiscovery.copydeskDiscoveryProvider;
};
