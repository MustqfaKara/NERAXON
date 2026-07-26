import { monitorService } from "@/lib/services/service-health";
import { readCredentialSync } from "@/lib/security/credential-vault";

const API_BASE_URL = "https://public-api.birdeye.so";
const MIN_REQUEST_INTERVAL_MS = 1_250;
const TOKEN_LIST_CACHE_MS = 5 * 60_000;
const TRADER_CACHE_MS = 20 * 60_000;
const GLOBAL_TRADER_CACHE_MS = 30 * 60_000;
const WALLET_CACHE_MS = 20 * 60_000;
const QUOTA_COOLDOWN_MS = 6 * 60 * 60_000;
let requestQueue: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

interface BirdeyeCacheEntry {
  expiresAt: number;
  value: unknown;
}

const globalBirdeyeState = globalThis as typeof globalThis & {
  __neraxonBirdeyeCache?: Map<string, BirdeyeCacheEntry>;
  __neraxonBirdeyeQuotaBlockedUntil?: number;
};
const responseCache = globalBirdeyeState.__neraxonBirdeyeCache ?? new Map<string, BirdeyeCacheEntry>();
globalBirdeyeState.__neraxonBirdeyeCache = responseCache;

export interface BirdeyeTokenListItem {
  address: string;
  symbol: string | null;
  price: number;
  liquidity: number;
  market_cap: number | null;
  volume_24h_usd: number;
  price_change_24h_percent: number;
  trade_24h_count: number;
  last_trade_unix_time: number;
  holder: number;
  recent_listing_time: number | null;
}

export interface BirdeyeTokenTrader {
  tokenAddress: string;
  owner: string;
  tags: string[];
  trade: number;
  tradeBuy: number;
  tradeSell: number;
  volumeUsd: number;
  volumeBuyUSD: number;
  volumeSellUSD: number;
  totalPnl: number;
  unrealizedPnl: number;
  realizedPnl: number;
}

export interface BirdeyeGlobalTrader {
  address: string;
  pnl: number;
  realized_pnl: number;
  unrealized_pnl: number;
  volume: number;
  trade_count: number;
}

export interface BirdeyeWalletPnlSummary {
  unique_tokens: number;
  counts: {
    total_buy: number;
    total_sell: number;
    total_trade: number;
    total_win: number;
    total_loss: number;
    win_rate: number;
  };
  cashflow_usd: {
    total_invested: number;
    total_sold: number;
    current_value: number;
  };
  pnl: {
    realized_profit_usd: number;
    realized_profit_percent: number;
    unrealized_usd: number;
    total_usd: number;
    avg_profit_per_trade_usd: number;
  };
}

export interface BirdeyeWalletTokenPnl {
  address: string;
  symbol: string;
  last_trade_unix_time: number;
  counts: { total_buy: number; total_sell: number; total_trade: number };
  cashflow_usd: {
    cost_of_quantity_sold: number;
    total_invested: number;
    total_sold: number;
    current_value: number;
  };
  pnl: {
    realized_profit_usd: number;
    realized_profit_percent: number;
    unrealized_usd: number;
    total_usd: number;
    total_percent: number;
  };
}

export async function getBirdeyeSolanaTokens() {
  const params = new URLSearchParams({
    sort_by: "volume_24h_usd",
    sort_type: "desc",
    min_liquidity: "25000",
    min_volume_24h_usd: "25000",
    min_price_change_24h_percent: "5",
    max_market_cap: "20000000",
    offset: "0",
    limit: "100",
    ui_amount_mode: "scaled",
  });
  const payload = await cachedBirdeyeRequest<{ data?: { items?: BirdeyeTokenListItem[] } }>(
    "solana-token-list",
    TOKEN_LIST_CACHE_MS,
    `/defi/v3/token/list?${params}`,
  );
  return payload.data?.items ?? [];
}

export async function getBirdeyeTokenTopTraders(tokenAddress: string) {
  const params = new URLSearchParams({
    address: tokenAddress,
    time_frame: "24h",
    sort_type: "desc",
    sort_by: "realized_pnl",
    offset: "0",
    limit: "10",
  });
  const payload = await cachedBirdeyeRequest<{ data?: { items?: BirdeyeTokenTrader[] } }>(
    `token-traders:${tokenAddress}`,
    TRADER_CACHE_MS,
    `/defi/v2/tokens/top_traders?${params}`,
  );
  return payload.data?.items ?? [];
}

export async function getBirdeyeGlobalTraders() {
  const params = new URLSearchParams({ type: "1W", sort_by: "realized_pnl", sort_type: "desc", offset: "0", limit: "100" });
  const payload = await cachedBirdeyeRequest<{ data?: { items?: BirdeyeGlobalTrader[] } }>(
    "global-traders:1w",
    GLOBAL_TRADER_CACHE_MS,
    `/trader/gainers-losers?${params}`,
  );
  return payload.data?.items ?? [];
}

export async function getBirdeyeWalletSummary(wallet: string, duration: "24h" | "7d") {
  const params = new URLSearchParams({ wallet, duration, position_scope: "cumulative" });
  const payload = await cachedBirdeyeRequest<{ data?: { summary?: BirdeyeWalletPnlSummary } }>(
    `wallet-summary:${wallet}:${duration}`,
    WALLET_CACHE_MS,
    `/wallet/v2/pnl/summary?${params}`,
  );
  if (!payload.data?.summary) throw new Error("Birdeye cüzdan PnL özeti boş döndü.");
  return payload.data.summary;
}

export async function getBirdeyeWalletTokenDetails(wallet: string, tokenAddresses: string[]) {
  const normalizedTokens = [...new Set(tokenAddresses)].sort();
  const payload = await cachedBirdeyeRequest<{ data?: { tokens?: BirdeyeWalletTokenPnl[] } }>(
    `wallet-details:${wallet}:${normalizedTokens.join(",")}`,
    WALLET_CACHE_MS,
    "/wallet/v2/pnl/details",
    {
      method: "POST",
      body: JSON.stringify({
        wallet,
        token_addresses: normalizedTokens,
        duration: "24h",
        position_scope: "cumulative",
        sort_type: "desc",
        sort_by: "last_trade",
        limit: Math.min(100, normalizedTokens.length),
        offset: 0,
      }),
    },
  );
  return payload.data?.tokens ?? [];
}

async function cachedBirdeyeRequest<T>(key: string, ttlMs: number, path: string, init: RequestInit = {}) {
  const cached = responseCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;
  if (cached) responseCache.delete(key);
  const value = await birdeyeRequest<T>(path, init);
  responseCache.set(key, { expiresAt: Date.now() + ttlMs, value });
  return value;
}

async function birdeyeRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const apiKey = readCredentialSync("birdeye-api-key");
  if (!apiKey) throw new Error("BIRDEYE_API_KEY yapılandırılmadı.");
  return enqueueRequest(async () => {
    if ((globalBirdeyeState.__neraxonBirdeyeQuotaBlockedUntil ?? 0) > Date.now()) {
      throw new Error("Birdeye compute kotası geçici olarak devre dışı.");
    }
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await waitForRateSlot();
        return await monitorService("birdeye", async () => {
          const response = await fetch(`${API_BASE_URL}${path}`, {
            ...init,
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              "X-API-KEY": apiKey,
              "x-chain": "solana",
              ...init.headers,
            },
            signal: AbortSignal.timeout(20_000),
            cache: "no-store",
          });
          const payload = await response.json() as T & { message?: string };
          if (!response.ok) throw new Error(payload.message ?? `Birdeye isteği başarısız (${response.status}).`);
          return payload;
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("Birdeye isteği başarısız.");
        if (isBirdeyeQuotaError(lastError)) {
          globalBirdeyeState.__neraxonBirdeyeQuotaBlockedUntil = Date.now() + QUOTA_COOLDOWN_MS;
          throw lastError;
        }
        if (attempt < 4 && /429|too many requests|rate limit/i.test(lastError.message)) {
          await delay(1_500 * (attempt + 1));
          continue;
        }
        if (attempt < 2 && /fetch|timeout|5\d\d/i.test(lastError.message)) {
          await delay(750 * 2 ** attempt);
          continue;
        }
        throw lastError;
      }
    }
    throw lastError ?? new Error("Birdeye tekrar denemelerden sonra yanıt vermedi.");
  });
}

export function isBirdeyeQuotaError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /compute units|compute kotası|usage limit|quota/i.test(message);
}

export function isBirdeyeCoolingDown() {
  return (globalBirdeyeState.__neraxonBirdeyeQuotaBlockedUntil ?? 0) > Date.now();
}

function enqueueRequest<T>(operation: () => Promise<T>) {
  const result = requestQueue.then(operation);
  requestQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function waitForRateSlot() {
  const waitMs = Math.max(0, MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt));
  if (waitMs) await delay(waitMs);
  lastRequestAt = Date.now();
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
