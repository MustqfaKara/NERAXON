import { type Address } from "viem";
import { getWrappedNativeAddress } from "@/lib/chains/token-config";
import { CHAIN_DEFINITIONS } from "@/lib/domain/defaults";
import type {
  DiscoveryGainerToken,
  DiscoveryTokenPerformance,
  WalletDiscoveryCandidate,
  WalletDiscoveryScan,
} from "@/lib/domain/types";
import { calculateDiscoveryScore } from "@/lib/engine/discovery-scoring";
import { calculateMarkToMarketPnl, isDiscoveryTokenPerformanceEligible, isDiscoveryWalletEligible } from "@/lib/engine/discovery-pnl";
import { estimatePaperGas } from "@/lib/services/gas-estimator";
import { monitorService } from "@/lib/services/service-health";
import { getPublicClient } from "@/lib/chains/public-client";
import { scanPublicErc20Transfers } from "@/lib/services/evm-public-transfer-scanner";
import { isQuoteToken } from "@/lib/chains/token-config";
import { getDexScreenerPromotedPairs } from "@/lib/services/dexscreener-discovery-universe";
import { scanGeckoPoolTrades } from "@/lib/services/geckoterminal-pool-trades";
import { isEvmRpcUrlAvailable, recordEvmRpcProviderFailure } from "@/lib/chains/evm-rpc-pool";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const TOP_GAINER_LIMIT = 10;
const MIN_LIQUIDITY_USD = 10_000;
const MAX_PRICE_CHANGE_PERCENT = 10_000;
const MAX_CANDIDATES_TO_VERIFY = 250;
const TRANSFER_PAGE_SIZE = 1_000;
const MAX_TRANSFER_PAGES = 100;
const RPC_MAX_ATTEMPTS = 5;
const robinhoodDiscoveryClient = getPublicClient("robinhood");
type RobinhoodDiscoveryClient = typeof robinhoodDiscoveryClient;

interface DexPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string | null;
  priceNative?: string | null;
  liquidity?: { usd?: number | null } | null;
  volume?: { h24?: number | null } | null;
  priceChange?: { h24?: number | null } | null;
  marketCap?: number | null;
  fdv?: number | null;
}

interface ObservedTransfer {
  hash: string;
  from: string;
  to: string;
  tokenAddress: string;
  value: number;
  timestamp: string;
}

interface AlchemyTransfer {
  hash: string;
  from: string | null;
  to: string | null;
  value?: number | null;
  rawContract?: { address?: string | null };
  metadata?: { blockTimestamp?: string };
}

interface AlchemyTransferPage {
  transfers: AlchemyTransfer[];
  pageKey?: string;
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

export async function scanRobinhoodWallets(): Promise<WalletDiscoveryScan> {
  const client = robinhoodDiscoveryClient;
  const latestBlock = await client.getBlockNumber();
  const latest = await client.getBlock({ blockNumber: latestBlock });
  const targetTimestamp = latest.timestamp - 86_400n;
  const fromBlock = await findFirstBlockAtOrAfter(client, latestBlock, targetTimestamp);
  const first = await client.getBlock({ blockNumber: fromBlock });
  const topGainers = await getDexScreenerTopGainers();
  const windowStartedAt = new Date(Number(first.timestamp) * 1_000).toISOString();
  if (!topGainers.length) return emptyScan(windowStartedAt);

  const [transferPage, gasEstimate] = await Promise.all([
    getDiscoveryTransfers(fromBlock, latestBlock, topGainers),
    estimatePaperGas("robinhood"),
  ]);
  const transfers = transferPage.transfers
    .map(toObservedTransfer)
    .filter((transfer): transfer is ObservedTransfer => Boolean(transfer));
  const candidates = await analyzeTransfers(transfers, topGainers, gasEstimate.feeUsd);
  const scan: WalletDiscoveryScan = {
    chainId: "robinhood",
    candidates,
    transferSampleSize: transfers.length,
    transactionSampleSize: new Set(transfers.map((transfer) => transfer.hash)).size,
    topGainers,
    pnlDataSource: transferPage.source === "public-rpc"
      ? "dexscreener+public-rpc"
      : transferPage.source === "geckoterminal" ? "dexscreener+geckoterminal+rpc" : "dexscreener+rpc",
    windowStartedAt,
    generatedAt: new Date().toISOString(),
  };
  return scan;
}

async function getDiscoveryTransfers(fromBlock: bigint, toBlock: bigint, markets: DiscoveryGainerToken[]) {
  const tokenAddresses = markets.map((market) => market.address as Address);
  try {
    const indexed = await getAlchemyTransfers(fromBlock, tokenAddresses);
    if (indexed.transfers.length) return { ...indexed, source: "alchemy" as const };
  } catch {
    // İndeksli pool trade fallback aşağıda denenir.
  }
  const indexedTransfers = await scanGeckoPoolTrades("robinhood", markets);
  if (indexedTransfers.length) {
    return {
      transfers: indexedTransfers.map((transfer) => ({
        hash: transfer.hash,
        from: transfer.from,
        to: transfer.to,
        value: transfer.value,
        rawContract: { address: transfer.tokenAddress },
        metadata: { blockTimestamp: transfer.timestamp },
      })),
      truncated: false,
      source: "geckoterminal" as const,
    };
  }
  const transfers = await scanPublicErc20Transfers("robinhood", fromBlock, toBlock, tokenAddresses);
  return {
    transfers: transfers.map((transfer) => ({
      hash: transfer.hash,
      from: transfer.from,
      to: transfer.to,
      value: transfer.value,
      rawContract: { address: transfer.tokenAddress },
      metadata: { blockTimestamp: transfer.timestamp },
    })),
    truncated: false,
    source: "public-rpc" as const,
  };
}

async function getDexScreenerTopGainers(): Promise<DiscoveryGainerToken[]> {
  const wrappedNative = getWrappedNativeAddress("robinhood");
  const response = await monitorService("dexscreener", () => fetch(
    `https://api.dexscreener.com/latest/dex/search?q=${wrappedNative}`,
    { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" }, cache: "no-store" },
  ));
  if (!response.ok) throw new Error(`DexScreener Robinhood piyasaları alınamadı (${response.status}).`);
  const payload = await response.json() as { pairs?: DexPair[] };
  const promotedPairs = await getDexScreenerPromotedPairs("robinhood");
  const bestByToken = new Map<string, { pair: DexPair; targetSide: "base" | "quote" }>();
  for (const pair of [...(payload.pairs ?? []), ...promotedPairs]) {
    if (pair.chainId !== "robinhood") continue;
    const baseAddress = pair.baseToken?.address?.toLowerCase();
    const quoteAddress = pair.quoteToken?.address?.toLowerCase();
    const targetSide = quoteAddress === wrappedNative ? "base" : baseAddress === wrappedNative ? "quote" : null;
    const tokenAddress = targetSide === "base" ? baseAddress : targetSide === "quote" ? quoteAddress : null;
    if (!targetSide || !tokenAddress || tokenAddress === wrappedNative || isQuoteToken("robinhood", tokenAddress)) continue;
    const existing = bestByToken.get(tokenAddress);
    if (!existing || Number(pair.liquidity?.usd ?? 0) > Number(existing.pair.liquidity?.usd ?? 0)) {
      bestByToken.set(tokenAddress, { pair, targetSide });
    }
  }
  return [...bestByToken.entries()]
    .map(([address, { pair, targetSide }]) => {
      const basePriceUsd = Number(pair.priceUsd ?? 0);
      const basePriceInQuote = Number(pair.priceNative ?? 0);
      const pairChange = Number(pair.priceChange?.h24 ?? 0);
      return {
        address,
        symbol: (targetSide === "base" ? pair.baseToken?.symbol : pair.quoteToken?.symbol) ?? "TOKEN",
        priceUsd: targetSide === "base" ? basePriceUsd : basePriceInQuote > 0 ? basePriceUsd / basePriceInQuote : 0,
        priceChange24hPercent: targetSide === "base" ? pairChange : inversePriceChange(pairChange),
        liquidityUsd: Number(pair.liquidity?.usd ?? 0),
        volume24hUsd: Number(pair.volume?.h24 ?? 0),
        marketCapUsd: targetSide === "base" && typeof pair.marketCap === "number" ? pair.marketCap : targetSide === "base" && typeof pair.fdv === "number" ? pair.fdv : null,
        pairAddress: pair.pairAddress?.toLowerCase() ?? "",
        dexId: pair.dexId ?? "unknown",
      };
    })
    .filter((market) => market.priceUsd > 0)
    .filter((market) => market.priceChange24hPercent > 0 && market.priceChange24hPercent <= MAX_PRICE_CHANGE_PERCENT)
    .filter((market) => market.liquidityUsd >= MIN_LIQUIDITY_USD)
    .sort((left, right) => right.priceChange24hPercent - left.priceChange24hPercent || right.volume24hUsd - left.volume24hUsd)
    .slice(0, TOP_GAINER_LIMIT);
}

async function findFirstBlockAtOrAfter(client: RobinhoodDiscoveryClient, latestBlock: bigint, targetTimestamp: bigint) {
  let low = 0n;
  let high = latestBlock;
  while (high - low > 1n) {
    const middle = (low + high) / 2n;
    const block = await client.getBlock({ blockNumber: middle });
    if (block.timestamp < targetTimestamp) low = middle;
    else high = middle;
  }
  return high;
}

async function getAlchemyTransfers(fromBlock: bigint, tokenAddresses: Address[]) {
  const transfers: AlchemyTransfer[] = [];
  let pageKey: string | undefined;
  let page = 0;
  do {
    const result = await alchemyRequest<AlchemyTransferPage>("alchemy_getAssetTransfers", [{
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: "latest",
      category: ["erc20"],
      contractAddresses: tokenAddresses,
      maxCount: `0x${TRANSFER_PAGE_SIZE.toString(16)}`,
      order: "asc",
      withMetadata: true,
      excludeZeroValue: true,
      ...(pageKey ? { pageKey } : {}),
    }]);
    transfers.push(...result.transfers);
    pageKey = result.pageKey;
    page += 1;
  } while (pageKey && page < MAX_TRANSFER_PAGES);
  return { transfers, truncated: Boolean(pageKey) };
}

async function alchemyRequest<T>(method: string, params: unknown[]): Promise<T> {
  const rpcUrl = CHAIN_DEFINITIONS.robinhood.rpcUrl;
  if (!isEvmRpcUrlAvailable(rpcUrl)) throw new Error("Alchemy RPC kota bekleme süresinde.");
  for (let attempt = 0; attempt < RPC_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    if (!response.ok) {
      const detail = await response.text();
      recordEvmRpcProviderFailure(rpcUrl, method, detail, response.status === 429);
      if (response.status === 429 && !/monthly capacity limit exceeded/i.test(detail) && attempt < RPC_MAX_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      throw new Error(`Robinhood Alchemy transfer sorgusu başarısız (${response.status}).`);
    }
    const payload = await response.json() as { result?: T; error?: { message?: string } };
    if (payload.error || payload.result === undefined) {
      const message = payload.error?.message ?? "Robinhood transfer verisi dönmedi.";
      recordEvmRpcProviderFailure(rpcUrl, method, message);
      throw new Error(message);
    }
    return payload.result;
  }
  throw new Error("Robinhood transfer sorgusu hız sınırı nedeniyle tamamlanamadı.");
}

function toObservedTransfer(transfer: AlchemyTransfer): ObservedTransfer | null {
  const tokenAddress = transfer.rawContract?.address?.toLowerCase();
  const value = Number(transfer.value ?? 0);
  if (!transfer.hash || !tokenAddress || !transfer.from || !transfer.to || !Number.isFinite(value) || value <= 0) return null;
  return {
    hash: transfer.hash.toLowerCase(),
    from: transfer.from.toLowerCase(),
    to: transfer.to.toLowerCase(),
    tokenAddress,
    value,
    timestamp: transfer.metadata?.blockTimestamp ?? new Date().toISOString(),
  };
}

async function analyzeTransfers(transfers: ObservedTransfer[], markets: DiscoveryGainerToken[], estimatedGasPerSwapUsd: number) {
  const grouped = new Map<string, ObservedTransfer[]>();
  for (const transfer of transfers) grouped.set(transfer.hash, [...(grouped.get(transfer.hash) ?? []), transfer]);
  const ignoredAddresses = new Set<string>([ZERO_ADDRESS, ...markets.map((market) => market.pairAddress).filter(isAddress)]);
  const wallets = new Map<string, WalletAccumulator>();

  for (const [hash, transactionTransfers] of grouped) {
    for (const market of markets) {
      const tokenTransfers = transactionTransfers.filter((transfer) => transfer.tokenAddress === market.address);
      if (!tokenTransfers.length) continue;
      const addresses = new Set(tokenTransfers.flatMap((transfer) => [transfer.from, transfer.to]));
      for (const address of addresses) {
        if (ignoredAddresses.has(address)) continue;
        const incoming = sum(tokenTransfers.filter((transfer) => transfer.to === address).map((transfer) => transfer.value));
        const outgoing = sum(tokenTransfers.filter((transfer) => transfer.from === address).map((transfer) => transfer.value));
        const netAmount = incoming - outgoing;
        if (!Number.isFinite(netAmount) || netAmount === 0) continue;
        const timestamp = tokenTransfers.reduce((latest, transfer) => transfer.timestamp > latest ? transfer.timestamp : latest, tokenTransfers[0].timestamp);
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

  const analyzed = [...wallets.values()]
    .map(finalizeCandidate)
    .filter((candidate): candidate is WalletDiscoveryCandidate => Boolean(candidate))
    .sort((left, right) => right.estimatedPnlUsd - left.estimatedPnlUsd || right.score - left.score)
    .slice(0, MAX_CANDIDATES_TO_VERIFY);
  return filterExternallyOwnedAccounts(clientForFiltering(), analyzed);
}

function finalizeCandidate(wallet: WalletAccumulator): WalletDiscoveryCandidate | null {
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
  const hashes = new Set(gainerTokens.flatMap((token) => [...(wallet.flows.get(token.address)?.hashes ?? [])]));
  const buyCount = sum(gainerTokens.map((token) => token.buyCount));
  const sellCount = sum(gainerTokens.map((token) => token.sellCount));
  if (!isDiscoveryWalletEligible({ boughtUsd, soldUsd, currentValueUsd, estimatedPnlUsd, estimatedPnlPercent, swapCount: hashes.size })) return null;
  const scoring = calculateDiscoveryScore({
    swapCount: hashes.size,
    buyCount,
    sellCount,
    uniqueTokenCount: gainerTokens.length,
    ageMinutes: Math.max(0, (Date.now() - new Date(wallet.lastActiveAt).getTime()) / 60_000),
    estimatedPnlPercent,
    boughtUsd,
    estimatedPnlUsd,
  });
  return {
    address: wallet.address,
    chainId: "robinhood",
    score: scoring.score,
    scoreBreakdown: scoring.breakdown,
    swapCount: hashes.size,
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
    sampleTxHashes: [...hashes].slice(0, 3),
  };
}

async function filterExternallyOwnedAccounts(client: RobinhoodDiscoveryClient, candidates: WalletDiscoveryCandidate[]) {
  const verified: WalletDiscoveryCandidate[] = [];
  for (let index = 0; index < candidates.length; index += 20) {
    const chunk = candidates.slice(index, index + 20);
    const bytecodes = await Promise.all(chunk.map((candidate) => client.getBytecode({ address: candidate.address as Address }).catch(() => undefined)));
    for (let offset = 0; offset < chunk.length; offset += 1) {
      if (!bytecodes[offset] || bytecodes[offset] === "0x") verified.push(chunk[offset]);
    }
  }
  return verified;
}

function clientForFiltering() {
  return robinhoodDiscoveryClient;
}

function createTokenFlow(market: DiscoveryGainerToken): TokenFlow {
  return { market, boughtUsd: 0, soldUsd: 0, netTokenAmount: 0, gasCostUsd: 0, buyCount: 0, sellCount: 0, hashes: new Set<string>() };
}

function estimateEntryPrice(market: DiscoveryGainerToken, timestamp: string) {
  const ageFraction = Math.min(1, Math.max(0, (Date.now() - new Date(timestamp).getTime()) / 86_400_000));
  return market.priceUsd / Math.max(0.01, 1 + market.priceChange24hPercent * ageFraction / 100);
}

function emptyScan(windowStartedAt: string): WalletDiscoveryScan {
  return {
    chainId: "robinhood",
    candidates: [],
    transferSampleSize: 0,
    transactionSampleSize: 0,
    topGainers: [],
    pnlDataSource: "dexscreener+rpc",
    windowStartedAt,
    generatedAt: new Date().toISOString(),
  };
}

const isAddress = (value: string) => /^0x[0-9a-f]{40}$/.test(value);
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const inversePriceChange = (percent: number) => percent <= -99.99 ? 10_000 : (1 / (1 + percent / 100) - 1) * 100;
