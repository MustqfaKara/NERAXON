import type { HypercoreFillObservation, HypercoreMarketType } from "@/lib/domain/types";
import { mapSpotUniverseContexts } from "@/lib/engine/hypercore-market-mapping";
import { monitorService } from "@/lib/services/service-health";
import { readCredentialSync } from "@/lib/security/credential-vault";

const INFO_URL = readCredentialSync("hyperliquid-info-url") ?? "https://api.hyperliquid.xyz/info";
const LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const REQUEST_TIMEOUT_MS = 30_000;

interface RawFill {
  coin: string;
  px: string;
  sz: string;
  side: "A" | "B";
  time: number;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  startPosition: string;
  fee: string;
  tid: number;
}

interface AssetContext {
  markPx?: string;
  midPx?: string | null;
  prevDayPx?: string;
  dayNtlVlm?: string;
  funding?: string;
  openInterest?: string;
  coin?: string;
}

interface PerpMeta { universe: Array<{ name: string; maxLeverage: number; szDecimals: number }> }
interface PerpDex { name: string }
interface SpotMeta {
  universe: Array<{ name: string; index: number; tokens: [number, number] }>;
  tokens: Array<{ index: number; name: string; szDecimals: number }>;
}

export interface HypercoreMarket {
  key: string;
  symbol: string;
  marketType: HypercoreMarketType;
  priceUsd: number;
  previousDayPriceUsd: number;
  priceChange24hPercent: number;
  volume24hUsd: number;
  maxLeverage: number;
  fundingRate: number;
  openInterestUsd: number;
  assetId: number;
  sizeDecimals: number;
}

export interface HypercoreLeaderboardRow {
  address: string;
  displayName: string | null;
  accountValueUsd: number;
  pnl24hUsd: number;
  roi24hPercent: number;
  volume24hUsd: number;
  pnl7dUsd: number;
  roi7dPercent: number;
}

interface RawLeaderboardRow {
  ethAddress: string;
  accountValue: string;
  displayName: string | null;
  windowPerformances: Array<[string, { pnl: string; roi: string; vlm: string }]>;
}

let marketCache: { expiresAt: number; markets: HypercoreMarket[] } | null = null;
let leaderboardCache: { expiresAt: number; rows: HypercoreLeaderboardRow[] } | null = null;
let perpDexCache: { expiresAt: number; names: string[] } | null = null;

export async function hypercoreInfo<T>(body: Record<string, unknown>): Promise<T> {
  return monitorService("hyperliquid_info", async () => {
    const response = await fetch(INFO_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HyperCore Info API hatası (${response.status}).`);
    return response.json() as Promise<T>;
  });
}

export async function getHypercoreMarkets(forceRefresh = false): Promise<HypercoreMarket[]> {
  if (!forceRefresh && marketCache && marketCache.expiresAt > Date.now()) return marketCache.markets;
  const [[perpMeta, perpContexts], [spotMeta, spotContexts], perpDexs] = await Promise.all([
    hypercoreInfo<[PerpMeta, AssetContext[]]>({ type: "metaAndAssetCtxs" }),
    hypercoreInfo<[SpotMeta, AssetContext[]]>({ type: "spotMetaAndAssetCtxs" }),
    hypercoreInfo<Array<PerpDex | null>>({ type: "perpDexs" }),
  ]);
  const perpMarkets = perpMeta.universe.map((asset, index) => toMarket(
    asset.name,
    asset.name,
    "perp",
    perpContexts[index],
    asset.maxLeverage,
    index,
    asset.szDecimals,
  ));
  const spotMarkets = mapHypercoreSpotMarkets(spotMeta, spotContexts);
  const builderDexMarkets = (await mapWithConcurrency(
    perpDexs
      .map((dex, index) => ({ dex, index }))
      .filter((item): item is { dex: PerpDex; index: number } => item.index > 0 && Boolean(item.dex?.name)),
    3,
    async ({ dex, index: dexIndex }) => {
      try {
        const [meta, contexts] = await hypercoreInfo<[PerpMeta, AssetContext[]]>({
          type: "metaAndAssetCtxs",
          dex: dex.name,
        });
        return meta.universe.map((asset, marketIndex) => toMarket(
          asset.name,
          asset.name,
          "perp",
          contexts[marketIndex],
          asset.maxLeverage,
          100_000 + dexIndex * 10_000 + marketIndex,
          asset.szDecimals,
        ));
      } catch {
        return [];
      }
    },
  )).flat();
  const markets = [...perpMarkets, ...builderDexMarkets, ...spotMarkets].filter((market) => market.priceUsd > 0);
  marketCache = { expiresAt: Date.now() + 30_000, markets };
  return markets;
}

export function hypercoreDexName(coin: string) {
  const separator = coin.indexOf(":");
  return separator > 0 ? coin.slice(0, separator) : null;
}

export async function getHypercorePerpDexNames(forceRefresh = false) {
  if (!forceRefresh && perpDexCache && perpDexCache.expiresAt > Date.now()) return perpDexCache.names;
  const dexes = await hypercoreInfo<Array<PerpDex | null>>({ type: "perpDexs" });
  const names = dexes
    .map((dex) => dex?.name?.trim())
    .filter((name): name is string => Boolean(name));
  perpDexCache = { expiresAt: Date.now() + 5 * 60_000, names };
  return names;
}

export function getHypercoreClearinghouseState<T>(user: string, coin?: string) {
  const dex = coin ? hypercoreDexName(coin) : null;
  return hypercoreInfo<T>({
    type: "clearinghouseState",
    user: user.toLowerCase(),
    ...(dex ? { dex } : {}),
  });
}

export async function getAllHypercoreClearinghouseStates<T>(user: string) {
  const dexNames = await getHypercorePerpDexNames();
  const states = await Promise.all([
    hypercoreInfo<T>({ type: "clearinghouseState", user: user.toLowerCase() }),
    ...dexNames.map((dex) => hypercoreInfo<T>({
      type: "clearinghouseState",
      user: user.toLowerCase(),
      dex,
    })),
  ]);
  return states;
}

export function mapHypercoreSpotMarkets(spotMeta: SpotMeta, spotContexts: AssetContext[]) {
  return mapSpotUniverseContexts(spotMeta.universe, spotMeta.tokens, spotContexts).map(({ asset, baseToken, context }) => {
    return toMarket(
      `@${asset.index}`,
      baseToken?.name ?? asset.name.split("/")[0],
      "spot",
      context,
      1,
      10_000 + asset.index,
      baseToken?.szDecimals ?? 0,
    );
  });
}

export function findHypercoreMarket(markets: HypercoreMarket[], marketType: HypercoreMarketType, coin: string) {
  const normalizedCoin = coin.trim().toLowerCase();
  return markets.find((market) => (
    market.marketType === marketType
    && (market.key.toLowerCase() === normalizedCoin || market.symbol.toLowerCase() === normalizedCoin)
  ));
}

export async function getHypercoreLeaderboard(forceRefresh = false): Promise<HypercoreLeaderboardRow[]> {
  if (!forceRefresh && leaderboardCache && leaderboardCache.expiresAt > Date.now()) return leaderboardCache.rows;
  const rows = await monitorService("hyperliquid_leaderboard", async () => {
    const response = await fetch(LEADERBOARD_URL, {
      signal: AbortSignal.timeout(60_000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Hyperliquid leaderboard hatası (${response.status}).`);
    const payload = await response.json() as { leaderboardRows: RawLeaderboardRow[] };
    return payload.leaderboardRows.map(normalizeLeaderboardRow);
  });
  leaderboardCache = { expiresAt: Date.now() + 10 * 60_000, rows };
  return rows;
}

export async function getHypercoreUserFills(address: string, startTime: number): Promise<HypercoreFillObservation[]> {
  const fills = await hypercoreInfo<RawFill[]>({
    type: "userFillsByTime",
    user: address.toLowerCase(),
    startTime,
    aggregateByTime: true,
  });
  return fills.map((fill) => normalizeFill(address, fill));
}

export async function getHypercoreUserLeverage(address: string, coin: string): Promise<number> {
  const state = await getHypercoreClearinghouseState<{ assetPositions?: Array<{ position?: { coin?: string; leverage?: { value?: number } } }> }>(address, coin);
  return Number(state.assetPositions?.find((item) => item.position?.coin === coin)?.position?.leverage?.value ?? 1);
}

export async function getHypercoreHealth() {
  const startedAt = performance.now();
  await hypercoreInfo<Record<string, string>>({ type: "allMids" });
  return {
    blockNumber: Math.floor(Date.now() / 1_000),
    latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
  };
}

function toMarket(key: string, symbol: string, marketType: HypercoreMarketType, context: AssetContext | undefined, maxLeverage: number, assetId: number, sizeDecimals: number): HypercoreMarket {
  const priceUsd = Number(context?.markPx ?? context?.midPx ?? 0);
  const previousDayPriceUsd = Number(context?.prevDayPx ?? priceUsd);
  return {
    key,
    symbol,
    marketType,
    priceUsd,
    previousDayPriceUsd,
    priceChange24hPercent: previousDayPriceUsd > 0 ? (priceUsd / previousDayPriceUsd - 1) * 100 : 0,
    volume24hUsd: Number(context?.dayNtlVlm ?? 0),
    maxLeverage,
    fundingRate: Number(context?.funding ?? 0),
    openInterestUsd: Number(context?.openInterest ?? 0) * priceUsd,
    assetId,
    sizeDecimals,
  };
}

function normalizeFill(address: string, fill: RawFill): HypercoreFillObservation {
  const priceUsd = Number(fill.px);
  const quantity = Number(fill.sz);
  const direction = fill.dir.toLowerCase();
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

function normalizeLeaderboardRow(row: RawLeaderboardRow): HypercoreLeaderboardRow {
  const performance = new Map(row.windowPerformances);
  const day = performance.get("day");
  const week = performance.get("week");
  return {
    address: row.ethAddress.toLowerCase(),
    displayName: row.displayName,
    accountValueUsd: Number(row.accountValue),
    pnl24hUsd: Number(day?.pnl ?? 0),
    roi24hPercent: Number(day?.roi ?? 0) * 100,
    volume24hUsd: Number(day?.vlm ?? 0),
    pnl7dUsd: Number(week?.pnl ?? 0),
    roi7dPercent: Number(week?.roi ?? 0) * 100,
  };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}
