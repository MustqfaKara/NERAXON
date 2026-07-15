import type { ChainId } from "@/lib/domain/types";
import { monitorService, recordServiceHealth } from "./service-health.ts";

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
}

interface DexPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string | null;
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

export class DexScreenerMarketDataProvider implements MarketDataProvider {
  private readonly cache = new Map<string, { expiresAt: number; value: MarketSnapshot }>();

  async getTokenMarket(chainId: ChainId, tokenAddress: string, options: MarketRequestOptions = {}): Promise<MarketSnapshot> {
    const normalizedAddress = tokenAddress.toLowerCase();
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
      const pairs = (await response.json()) as DexPair[];
      const candidates = pairs
        .filter((pair) => pair.chainId === chainId && pair.baseToken?.address?.toLowerCase() === normalizedAddress)
        .filter((pair) => Number(pair.priceUsd) > 0 && Number(pair.liquidity?.usd) > 0)
        .sort((left, right) => Number(right.liquidity?.usd ?? 0) - Number(left.liquidity?.usd ?? 0));
      const best = candidates[0];
      if (!best) throw new Error("Token için fiyat ve likidite sağlayan geçerli bir havuz bulunamadı.");

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
    const normalized = [...new Set(tokenAddresses.map((address) => address.toLowerCase()))];
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
      const pairs = await response.json() as DexPair[];
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
    const entries = await Promise.all([...new Set(tokenAddresses.map((address) => address.toLowerCase()))].map(async (tokenAddress) => {
      const response = await fetch(`https://api.dexscreener.com/token-pairs/v1/${chainId}/${tokenAddress}`, {
        signal: AbortSignal.timeout(10_000),
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Token havuzları alınamadı (${response.status}).`);
      const pairs = await response.json() as DexPair[];
      const addresses = pairs
        .filter((pair) => pair.chainId === chainId && pair.pairAddress)
        .filter((pair) => pair.baseToken?.address?.toLowerCase() === tokenAddress || pair.quoteToken?.address?.toLowerCase() === tokenAddress)
        .map((pair) => pair.pairAddress!.toLowerCase());
      return [tokenAddress, [...new Set(addresses)]] as [string, string[]];
    }));
    return Object.fromEntries(entries);
  }
}

function selectMarketSnapshot(chainId: ChainId, tokenAddress: string, pairs: DexPair[]): MarketSnapshot | null {
  const candidates = pairs
    .filter((pair) => pair.chainId === chainId && pair.baseToken?.address?.toLowerCase() === tokenAddress)
    .filter((pair) => Number(pair.priceUsd) > 0 && Number(pair.liquidity?.usd) > 0)
    .sort((left, right) => Number(right.liquidity?.usd ?? 0) - Number(left.liquidity?.usd ?? 0));
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

const MARKET_PROVIDER_VERSION = 4;
const globalState = globalThis as typeof globalThis & {
  copydeskMarketData?: MarketDataProvider;
  copydeskMarketDataVersion?: number;
};
export const getMarketDataProvider = () => {
  if (!globalState.copydeskMarketData || globalState.copydeskMarketDataVersion !== MARKET_PROVIDER_VERSION) {
    globalState.copydeskMarketData = new DexScreenerMarketDataProvider();
    globalState.copydeskMarketDataVersion = MARKET_PROVIDER_VERSION;
  }
  return globalState.copydeskMarketData!;
};
