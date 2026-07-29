import type { ChainId } from "@/lib/domain/types";
import { createPublicClient, formatEther, parseAbi, type Hex } from "viem";
import { monitorService, recordServiceHealth } from "./service-health.ts";
import { SOLANA_NATIVE_MINT, SOLANA_USDC_MINT, SOLANA_USDT_MINT } from "../solana/constants.ts";
import { createEvmFallbackTransport } from "../chains/evm-rpc-pool.ts";

export interface MarketSnapshot {
  chainId: ChainId;
  tokenAddress: string;
  tokenSymbol: string;
  priceUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  priceChange24hPercent: number;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  pairAddress: string;
  dexId: string;
  pairCreatedAt: number | null;
  fetchedAt: string;
  buys24h?: number;
  sells24h?: number;
  marketKind?: "amm" | "robinhood-portal";
  exitRouteVerified?: boolean;
}

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
  pairCreatedAt?: number | null;
  txns?: { h24?: { buys?: number; sells?: number } } | null;
}

export interface MarketDataProvider {
  getTokenMarket(chainId: ChainId, tokenAddress: string, options?: MarketRequestOptions): Promise<MarketSnapshot>;
  getTokenMarkets(chainId: ChainId, tokenAddresses: string[], options?: MarketRequestOptions): Promise<MarketSnapshot[]>;
  getTokenPoolAddresses(chainId: ChainId, tokenAddresses: string[]): Promise<Record<string, string[]>>;
}

export interface MarketRequestOptions {
  forceRefresh?: boolean;
}

const MARKET_CACHE_TTL_MS = 30_000;
const ROBINHOOD_STATE_VIEW = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b";
const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";
const Q96 = 2n ** 96n;
const STATE_VIEW_ABI = parseAbi([
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);
const robinhoodMarketClient = createPublicClient({
  transport: createEvmFallbackTransport("robinhood"),
});

export class DexScreenerMarketDataProvider implements MarketDataProvider {
  private readonly cache = new Map<string, { expiresAt: number; value: MarketSnapshot }>();

  async getTokenMarket(chainId: ChainId, tokenAddress: string, options: MarketRequestOptions = {}): Promise<MarketSnapshot> {
    const normalizedAddress = normalizeTokenAddress(chainId, tokenAddress);
    const cacheKey = `${chainId}:${normalizedAddress}`;
    const cached = this.cache.get(cacheKey);
    if (!options.forceRefresh && cached && cached.expiresAt > Date.now()) {
      recordServiceHealth("dexscreener", 0, null, true);
      return cached.value;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await monitorService("dexscreener", () => fetch(
        `https://api.dexscreener.com/token-pairs/v1/${chainId}/${normalizedAddress}`,
        { signal: controller.signal, headers: { accept: "application/json" } },
      ));
      if (!response.ok) throw new Error(`Piyasa verisi alınamadı (${response.status}).`);
      const pairs = await enrichRobinhoodV4Liquidity(chainId, (await response.json()) as DexPair[]);
      const tokenPairs = pairs
        .filter((pair) => pair.chainId === chainId && normalizeTokenAddress(chainId, pair.baseToken?.address ?? "") === normalizedAddress)
        .filter((pair) => Number(pair.priceUsd) > 0);
      const candidates = rankMarketPairs(chainId, tokenPairs.filter((pair) => Number(pair.liquidity?.usd) > 0));
      const best = candidates[0];
      if (!best && tokenPairs.length > 0) {
        throw new Error("Token havuzu bulundu ancak USD likiditesi DexScreener veya Robinhood v4 zincir verisiyle doğrulanamadı; canlı alım güvenlik nedeniyle yapılmadı.");
      }
      if (!best) throw new Error("Token için fiyat sağlayan geçerli bir havuz bulunamadı.");

      const snapshot: MarketSnapshot = {
        chainId,
        tokenAddress: normalizedAddress,
        tokenSymbol: best.baseToken?.symbol ?? "TOKEN",
        priceUsd: Number(best.priceUsd),
        liquidityUsd: Number(best.liquidity?.usd ?? 0),
        volume24hUsd: Number(best.volume?.h24 ?? 0),
        priceChange24hPercent: Number(best.priceChange?.h24 ?? 0),
        marketCapUsd: typeof best.marketCap === "number" ? best.marketCap : null,
        fdvUsd: typeof best.fdv === "number" ? best.fdv : null,
        pairAddress: best.pairAddress ?? "",
        dexId: best.dexId ?? "unknown",
        pairCreatedAt: best.pairCreatedAt ?? null,
        fetchedAt: new Date().toISOString(),
        buys24h: Number(best.txns?.h24?.buys ?? 0),
        sells24h: Number(best.txns?.h24?.sells ?? 0),
      };
      this.cache.set(cacheKey, { expiresAt: Date.now() + MARKET_CACHE_TTL_MS, value: snapshot });
      return snapshot;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getTokenMarkets(chainId: ChainId, tokenAddresses: string[], options: MarketRequestOptions = {}): Promise<MarketSnapshot[]> {
    const normalized = [...new Set(tokenAddresses.map((address) => normalizeTokenAddress(chainId, address)))];
    const markets: MarketSnapshot[] = [];
    const missing: string[] = [];
    for (const address of normalized) {
      const cached = this.cache.get(`${chainId}:${address}`);
      if (!options.forceRefresh && cached && cached.expiresAt > Date.now()) markets.push(cached.value);
      else missing.push(address);
    }

    for (let index = 0; index < missing.length; index += 30) {
      const addresses = missing.slice(index, index + 30);
      const response = await monitorService("dexscreener", () => fetch(
        `https://api.dexscreener.com/tokens/v1/${chainId}/${addresses.join(",")}`,
        { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } },
      ));
      if (!response.ok) throw new Error(`Toplu piyasa verisi alınamadı (${response.status}).`);
      const pairs = await enrichRobinhoodV4Liquidity(chainId, await response.json() as DexPair[]);
      for (const address of addresses) {
        const snapshot = selectMarketSnapshot(chainId, address, pairs);
        if (!snapshot) continue;
        this.cache.set(`${chainId}:${address}`, { expiresAt: Date.now() + MARKET_CACHE_TTL_MS, value: snapshot });
        markets.push(snapshot);
      }
    }
    return markets;
  }

  async getTokenPoolAddresses(chainId: ChainId, tokenAddresses: string[]) {
    const entries = await Promise.all([...new Set(tokenAddresses.map((address) => normalizeTokenAddress(chainId, address)))].map(async (tokenAddress) => {
      const response = await fetch(`https://api.dexscreener.com/token-pairs/v1/${chainId}/${tokenAddress}`, {
        signal: AbortSignal.timeout(10_000),
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Token havuzları alınamadı (${response.status}).`);
      const pairs = await response.json() as DexPair[];
      const addresses = pairs
        .filter((pair) => pair.chainId === chainId && pair.pairAddress)
        .filter((pair) => normalizeTokenAddress(chainId, pair.baseToken?.address ?? "") === tokenAddress || normalizeTokenAddress(chainId, pair.quoteToken?.address ?? "") === tokenAddress)
        .map((pair) => normalizeTokenAddress(chainId, pair.pairAddress!));
      return [tokenAddress, [...new Set(addresses)]] as [string, string[]];
    }));
    return Object.fromEntries(entries);
  }
}

function selectMarketSnapshot(chainId: ChainId, tokenAddress: string, pairs: DexPair[]): MarketSnapshot | null {
  const candidates = rankMarketPairs(chainId, pairs
    .filter((pair) => pair.chainId === chainId && normalizeTokenAddress(chainId, pair.baseToken?.address ?? "") === tokenAddress)
    .filter((pair) => Number(pair.priceUsd) > 0 && Number(pair.liquidity?.usd) > 0));
  const best = candidates[0];
  if (!best) return null;
  return {
    chainId,
    tokenAddress,
    tokenSymbol: best.baseToken?.symbol ?? "TOKEN",
    priceUsd: Number(best.priceUsd),
    liquidityUsd: Number(best.liquidity?.usd ?? 0),
    volume24hUsd: Number(best.volume?.h24 ?? 0),
    priceChange24hPercent: Number(best.priceChange?.h24 ?? 0),
    marketCapUsd: typeof best.marketCap === "number" ? best.marketCap : null,
    fdvUsd: typeof best.fdv === "number" ? best.fdv : null,
    pairAddress: best.pairAddress ?? "",
    dexId: best.dexId ?? "unknown",
    pairCreatedAt: best.pairCreatedAt ?? null,
    fetchedAt: new Date().toISOString(),
    buys24h: Number(best.txns?.h24?.buys ?? 0),
    sells24h: Number(best.txns?.h24?.sells ?? 0),
  };
}

const TRUSTED_SOLANA_QUOTES = new Set([SOLANA_NATIVE_MINT, SOLANA_USDC_MINT, SOLANA_USDT_MINT]);

function rankMarketPairs(chainId: ChainId, pairs: DexPair[]) {
  const priceConsistentPairs = filterPriceOutliers(pairs);
  const trusted = chainId === "solana"
    ? priceConsistentPairs.filter((pair) => TRUSTED_SOLANA_QUOTES.has(pair.quoteToken?.address ?? ""))
    : [];
  return (trusted.length > 0 ? trusted : priceConsistentPairs)
    .sort((left, right) => Number(right.liquidity?.usd ?? 0) - Number(left.liquidity?.usd ?? 0));
}

function filterPriceOutliers(pairs: DexPair[]) {
  const prices = pairs
    .map((pair) => Number(pair.priceUsd))
    .filter((price) => Number.isFinite(price) && price > 0)
    .sort((left, right) => left - right);
  if (prices.length < 3) return pairs;
  const middle = Math.floor(prices.length / 2);
  const median = prices.length % 2 === 0
    ? (prices[middle - 1] + prices[middle]) / 2
    : prices[middle];
  return pairs.filter((pair) => {
    const price = Number(pair.priceUsd);
    return Number.isFinite(price) && price >= median / 5 && price <= median * 5;
  });
}

function normalizeTokenAddress(chainId: ChainId, address: string) {
  return chainId === "solana" ? address.trim() : address.toLowerCase();
}

async function enrichRobinhoodV4Liquidity(chainId: ChainId, pairs: DexPair[]) {
  if (chainId !== "robinhood") return pairs;
  const reportedPrices = pairs
    .filter((pair) => Number(pair.liquidity?.usd) > 0)
    .map((pair) => Number(pair.priceUsd))
    .filter((price) => Number.isFinite(price) && price > 0)
    .sort((left, right) => left - right);
  const referencePriceUsd = median(reportedPrices);
  return Promise.all(pairs.map(async (pair) => {
    if (Number(pair.liquidity?.usd) > 0 || !isRobinhoodNativeV4Pair(pair)) return pair;
    const pairPriceUsd = Number(pair.priceUsd);
    if (referencePriceUsd > 0 && (pairPriceUsd < referencePriceUsd / 5 || pairPriceUsd > referencePriceUsd * 5)) {
      return pair;
    }
    try {
      const [activeLiquidity, slot0] = await Promise.all([
        robinhoodMarketClient.readContract({
          address: ROBINHOOD_STATE_VIEW,
          abi: STATE_VIEW_ABI,
          functionName: "getLiquidity",
          args: [pair.pairAddress as Hex],
        }),
        robinhoodMarketClient.readContract({
          address: ROBINHOOD_STATE_VIEW,
          abi: STATE_VIEW_ABI,
          functionName: "getSlot0",
          args: [pair.pairAddress as Hex],
        }),
      ]);
      const nativePriceUsd = Number(pair.priceUsd) / Number(pair.priceNative);
      const liquidityUsd = calculateRobinhoodV4LiquidityUsd(activeLiquidity, slot0[0], nativePriceUsd);
      return liquidityUsd > 0 ? { ...pair, liquidity: { usd: liquidityUsd } } : pair;
    } catch {
      return pair;
    }
  }));
}

function median(values: number[]) {
  if (!values.length) return 0;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? (values[middle - 1] + values[middle]) / 2
    : values[middle];
}

function isRobinhoodNativeV4Pair(pair: DexPair) {
  return pair.dexId?.toLowerCase().includes("uniswap")
    && pair.pairAddress?.startsWith("0x")
    && pair.pairAddress.length === 66
    && pair.quoteToken?.address?.toLowerCase() === NATIVE_ADDRESS
    && Number(pair.priceUsd) > 0
    && Number(pair.priceNative) > 0;
}

export function calculateRobinhoodV4LiquidityUsd(activeLiquidity: bigint, sqrtPriceX96: bigint, nativePriceUsd: number) {
  if (activeLiquidity <= 0n || sqrtPriceX96 <= 0n || !Number.isFinite(nativePriceUsd) || nativePriceUsd <= 0) return 0;
  const virtualNativeWei = activeLiquidity * Q96 / sqrtPriceX96;
  const twoSidedVirtualDepthUsd = Number(formatEther(virtualNativeWei)) * nativePriceUsd * 2;
  return Number.isFinite(twoSidedVirtualDepthUsd) ? Math.max(0, twoSidedVirtualDepthUsd) : 0;
}

const MARKET_PROVIDER_VERSION = 8;
const globalState = globalThis as typeof globalThis & {
  neraxonMarketData?: MarketDataProvider;
  neraxonMarketDataVersion?: number;
};
export const getMarketDataProvider = () => {
  if (!globalState.neraxonMarketData || globalState.neraxonMarketDataVersion !== MARKET_PROVIDER_VERSION) {
    globalState.neraxonMarketData = new DexScreenerMarketDataProvider();
    globalState.neraxonMarketDataVersion = MARKET_PROVIDER_VERSION;
  }
  return globalState.neraxonMarketData!;
};
