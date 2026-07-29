import type { DiscoveryGainerToken, DiscoveryTokenPerformance, WalletDiscoveryCandidate, WalletDiscoveryScan } from "@/lib/domain/types";
import { calculateDiscoveryScore } from "@/lib/engine/discovery-scoring";
import { calculateDiscoveryPnlPercent, isDiscoveryReturnEligible } from "@/lib/engine/discovery-pnl";
import { getHypercoreLeaderboard, getHypercoreMarkets, getHypercoreUserFills, type HypercoreLeaderboardRow, type HypercoreMarket } from "@/lib/services/hypercore-api";

const MIN_DAILY_PNL_USD = 100;
const MIN_DAILY_VOLUME_USD = 100;
const MAX_DAILY_BOUGHT_USD = 20_000;
const MAX_DAILY_VOLUME_USD = 40_000;
const MAX_ACCOUNT_VALUE_USD = 250_000;
const MIN_DAILY_ROI_PERCENT = 5;
const MAX_DAILY_ROI_PERCENT = 500;
const MAX_CANDIDATES = 40;
const MAX_CANDIDATES_TO_ENRICH = 160;
const MAX_DAILY_FILLS = 100;

export async function scanHypercoreWallets(): Promise<WalletDiscoveryScan> {
  const windowStartedAt = new Date(Date.now() - 86_400_000).toISOString();
  const [leaderboard, markets] = await Promise.all([getHypercoreLeaderboard(), getHypercoreMarkets()]);
  const topGainers = markets
    .filter((market) => market.priceChange24hPercent > 0 && market.volume24hUsd >= 100_000)
    .sort((left, right) => right.priceChange24hPercent - left.priceChange24hPercent)
    .slice(0, 10)
    .map(toDiscoveryMarket);
  const shortlist = leaderboard
    .filter((row) => row.pnl24hUsd >= MIN_DAILY_PNL_USD)
    .filter((row) => row.roi24hPercent >= MIN_DAILY_ROI_PERCENT && row.roi24hPercent <= MAX_DAILY_ROI_PERCENT)
    .filter((row) => row.accountValueUsd >= 100 && row.accountValueUsd <= MAX_ACCOUNT_VALUE_USD)
    .filter((row) => row.volume24hUsd >= MIN_DAILY_VOLUME_USD && row.volume24hUsd <= MAX_DAILY_VOLUME_USD)
    .sort((left, right) => leaderboardPriority(right) - leaderboardPriority(left))
    .slice(0, MAX_CANDIDATES_TO_ENRICH);
  const candidates: WalletDiscoveryCandidate[] = [];
  for (let index = 0; index < shortlist.length; index += 5) {
    const chunk = shortlist.slice(index, index + 5);
    const enriched = await Promise.all(chunk.map(async (row) => {
      try {
        return await enrichCandidate(row, markets);
      } catch {
        return null;
      }
    }));
    candidates.push(...enriched.filter((candidate): candidate is WalletDiscoveryCandidate => Boolean(candidate)));
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  const sorted = candidates
    .sort((left, right) => right.score - left.score || right.estimatedPnlUsd - left.estimatedPnlUsd)
    .slice(0, MAX_CANDIDATES);
  return {
    chainId: "hyperliquid",
    candidates: sorted,
    transferSampleSize: sorted.reduce((sum, candidate) => sum + candidate.swapCount, 0),
    transactionSampleSize: sorted.reduce((sum, candidate) => sum + candidate.swapCount, 0),
    topGainers,
    pnlDataSource: "hyperliquid-leaderboard",
    windowStartedAt,
    generatedAt: new Date().toISOString(),
  };
}

async function enrichCandidate(row: HypercoreLeaderboardRow, markets: HypercoreMarket[]): Promise<WalletDiscoveryCandidate | null> {
  const fills = await getHypercoreUserFills(row.address, Date.now() - 86_400_000);
  if (fills.length < 2 || fills.length > MAX_DAILY_FILLS) return null;
  if (fills.some((fill) => fill.notionalUsd > MAX_DAILY_BOUGHT_USD)) return null;
  const observedVolumeUsd = fills.reduce((sum, fill) => sum + fill.notionalUsd, 0);
  if (observedVolumeUsd < MIN_DAILY_VOLUME_USD || observedVolumeUsd > MAX_DAILY_VOLUME_USD) return null;
  const marketByKey = new Map(markets.map((market) => [market.key, market]));
  const grouped = new Map<string, typeof fills>();
  for (const fill of fills) grouped.set(`${fill.marketType}:${fill.coin}`, [...(grouped.get(`${fill.marketType}:${fill.coin}`) ?? []), fill]);
  const gainerTokens: DiscoveryTokenPerformance[] = [...grouped.entries()].map(([key, assetFills]) => {
    const first = assetFills[0];
    const market = marketByKey.get(first.coin) ?? markets.find((item) => item.symbol === first.coin && item.marketType === first.marketType);
    const boughtUsd = assetFills.filter((fill) => fill.side === "buy").reduce((sum, fill) => sum + fill.notionalUsd, 0);
    const soldUsd = assetFills.filter((fill) => fill.side === "sell").reduce((sum, fill) => sum + fill.notionalUsd, 0);
    const fees = assetFills.reduce((sum, fill) => sum + fill.feeUsd, 0);
    const pnl = assetFills.reduce((sum, fill) => sum + fill.closedPnlUsd, 0) - fees;
    return {
      address: key.toLowerCase(),
      symbol: market?.symbol ?? first.coin,
      priceUsd: market?.priceUsd ?? first.priceUsd,
      priceChange24hPercent: market?.priceChange24hPercent ?? 0,
      liquidityUsd: market?.openInterestUsd ?? market?.volume24hUsd ?? 0,
      volume24hUsd: market?.volume24hUsd ?? 0,
      marketCapUsd: null,
      pairAddress: first.coin,
      dexId: `hypercore-${first.marketType}`,
      boughtUsd,
      soldUsd,
      currentValueUsd: 0,
      estimatedPnlUsd: pnl,
      gasCostUsd: fees,
      swapCount: assetFills.length,
      buyCount: assetFills.filter((fill) => fill.side === "buy").length,
      sellCount: assetFills.filter((fill) => fill.side === "sell").length,
    };
  }).sort((left, right) => right.estimatedPnlUsd - left.estimatedPnlUsd);
  const buyCount = fills.filter((fill) => fill.side === "buy").length;
  const sellCount = fills.length - buyCount;
  if (!buyCount || !sellCount) return null;
  const boughtUsd = gainerTokens.reduce((sum, token) => sum + token.boughtUsd, 0);
  const soldUsd = gainerTokens.reduce((sum, token) => sum + token.soldUsd, 0);
  if (boughtUsd > MAX_DAILY_BOUGHT_USD || soldUsd > MAX_DAILY_VOLUME_USD) return null;
  const netPnlPercent = calculateDiscoveryPnlPercent(boughtUsd, row.pnl24hUsd);
  if (!isDiscoveryReturnEligible(boughtUsd, row.pnl24hUsd)) return null;
  const scoring = calculateDiscoveryScore({
    swapCount: fills.length,
    buyCount,
    sellCount,
    uniqueTokenCount: gainerTokens.length,
    ageMinutes: Math.max(0, (Date.now() - Math.max(...fills.map((fill) => fill.timestamp))) / 60_000),
    estimatedPnlPercent: netPnlPercent,
    boughtUsd: Math.max(MIN_DAILY_VOLUME_USD, Math.min(boughtUsd, MAX_DAILY_VOLUME_USD)),
    estimatedPnlUsd: row.pnl24hUsd,
  });
  return {
    address: row.address,
    chainId: "hyperliquid",
    score: scoring.score,
    scoreBreakdown: scoring.breakdown,
    swapCount: fills.length,
    buyCount,
    sellCount,
    uniqueTokenCount: gainerTokens.length,
    boughtUsd,
    soldUsd,
    currentValueUsd: row.accountValueUsd,
    estimatedPnlUsd: row.pnl24hUsd,
    estimatedPnlPercent: netPnlPercent,
    gasCostUsd: gainerTokens.reduce((sum, token) => sum + token.gasCostUsd, 0),
    gainerTokens,
    lastActiveAt: new Date(Math.max(...fills.map((fill) => fill.timestamp))).toISOString(),
    sampleTxHashes: fills.slice(0, 3).map((fill) => fill.id),
  };
}

function toDiscoveryMarket(market: HypercoreMarket): DiscoveryGainerToken {
  return {
    address: `${market.marketType}:${market.key}`.toLowerCase(),
    symbol: market.symbol,
    priceUsd: market.priceUsd,
    priceChange24hPercent: market.priceChange24hPercent,
    liquidityUsd: market.openInterestUsd,
    volume24hUsd: market.volume24hUsd,
    marketCapUsd: null,
    pairAddress: market.key,
    dexId: `hypercore-${market.marketType}`,
  };
}

const leaderboardPriority = (row: HypercoreLeaderboardRow) => row.pnl24hUsd / Math.max(1, row.volume24hUsd) * 10_000 + Math.min(20_000, row.pnl24hUsd);
