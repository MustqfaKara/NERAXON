import { PublicKey } from "@solana/web3.js";
import type { DiscoveryGainerToken, DiscoveryTokenPerformance, WalletDiscoveryCandidate, WalletDiscoveryScan } from "@/lib/domain/types";
import { isStablecoinAsset } from "@/lib/engine/stablecoin-filter";
import { calculateSolanaSmartWalletScore, solanaSmartWalletHistoryRejectionReasons, solanaSmartWalletRejectionReasons, type SolanaSmartWalletMetrics } from "@/lib/engine/solana-smart-wallet-score";
import {
  getBirdeyeSolanaTokens,
  getBirdeyeTokenTopTraders,
  getBirdeyeWalletSummary,
  getBirdeyeWalletTokenDetails,
  type BirdeyeTokenListItem,
  type BirdeyeTokenTrader,
  type BirdeyeWalletTokenPnl,
} from "@/lib/services/birdeye-api";
import { getMarketDataProvider } from "@/lib/services/market-data-provider";
import { solanaRpc } from "@/lib/solana/helius-client";

const TOP_GAINER_LIMIT = 10;
const TOP_GAINER_CANDIDATE_LIMIT = 24;
const MAX_SEED_WALLETS = 48;
const TARGET_CANDIDATES = 12;
const MAX_CANDIDATES = 30;
const MIN_DISCOVERY_SCORE = 60;
const SUSPICIOUS_TAGS = new Set(["bundler", "sniper", "insider", "dev"]);

interface WalletSeed {
  address: string;
  tags: Set<string>;
  tokenTraders: Map<string, BirdeyeTokenTrader>;
}

interface SignatureInfo { signature?: string; blockTime?: number | null; err?: unknown }

export async function scanBirdeyeSolanaWallets(): Promise<WalletDiscoveryScan> {
  const windowStartedAt = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
  const tokenUniverse = await getBirdeyeSolanaTokens();
  const eligibleTokens = tokenUniverse
    .filter((token) => isValidAddress(token.address))
    .filter((token) => !isStablecoinAsset("solana", token.address, token.symbol ?? ""))
    .filter((token) => finiteBetween(token.price_change_24h_percent, 5, 500))
    .filter((token) => token.liquidity >= 25_000 && token.volume_24h_usd >= 25_000 && token.holder >= 100)
    .filter((token) => !token.recent_listing_time || token.recent_listing_time <= Math.floor(Date.now() / 1_000) - 30 * 60);
  const selectedTokens = selectTokenCandidates(eligibleTokens);
  if (!selectedTokens.length) return emptyScan(windowStartedAt);

  const marketRows = await getMarketDataProvider().getTokenMarkets("solana", selectedTokens.map((token) => token.address));
  const marketByAddress = new Map(marketRows.map((market) => [market.tokenAddress, market]));
  const gainerCandidates: DiscoveryGainerToken[] = selectedTokens.map((token) => {
    const market = marketByAddress.get(token.address);
    return {
      address: token.address,
      symbol: token.symbol?.trim() || market?.tokenSymbol || "TOKEN",
      priceUsd: token.price,
      priceChange24hPercent: token.price_change_24h_percent,
      liquidityUsd: token.liquidity,
      volume24hUsd: token.volume_24h_usd,
      marketCapUsd: token.market_cap,
      pairAddress: market?.pairAddress ?? token.address,
      dexId: market?.dexId ?? "birdeye",
    };
  });

  const rejectionReasons: Record<string, number> = {};
  let providerErrorCount = 0;
  const tokenTraderGroupsPromise = Promise.all(gainerCandidates.map(async (token) => {
    try {
      return { token, traders: await getBirdeyeTokenTopTraders(token.address) };
    } catch (error) {
      providerErrorCount += 1;
      increment(rejectionReasons, `provider_${providerErrorReason(error)}`);
      return { token, traders: [] };
    }
  }));
  const allTokenTraderGroups = await tokenTraderGroupsPromise;
  const tokenTraderGroups = allTokenTraderGroups.filter((group) => group.traders.some(isUsableTokenTrader));
  const topGainers = [...gainerCandidates]
    .sort((left, right) => right.priceChange24hPercent - left.priceChange24hPercent)
    .slice(0, TOP_GAINER_LIMIT);
  const candidateGainers = tokenTraderGroups.map((group) => group.token);
  const seeds = buildSeeds(tokenTraderGroups);
  const validationSeeds = selectDiverseSeeds(seeds, MAX_SEED_WALLETS);
  const candidates: WalletDiscoveryCandidate[] = [];
  let tokenLinkedWallets = 0;
  let pnlValidatedWallets = 0;
  let attemptedWallets = 0;

  for (const seed of validationSeeds) {
    attemptedWallets += 1;
    try {
      const tokenPerformances = seed.tokenTraders.size
        ? [...seed.tokenTraders.values()].map((row) => performanceFromTrader(row, candidateGainers)).filter(notNull)
        : await performancesFromDetails(seed.address, topGainers);
      if (!tokenPerformances.length) {
        increment(rejectionReasons, "no_top_token");
        continue;
      }
      tokenLinkedWallets += 1;
      const summary7d = await getBirdeyeWalletSummary(seed.address, "7d");
      const closedTokens = summary7d.counts.total_win + summary7d.counts.total_loss;
      const suspiciousTagCount = [...seed.tags].filter((tag) => SUSPICIOUS_TAGS.has(tag)).length;
      pnlValidatedWallets += 1;
      const historyReasons = solanaSmartWalletHistoryRejectionReasons({
        invested7dUsd: summary7d.cashflow_usd.total_invested,
        uniqueTokens7d: summary7d.unique_tokens,
        closedTokens7d: closedTokens,
        winRate7d: normalizePercent(summary7d.counts.win_rate),
        realizedPnl7dUsd: summary7d.pnl.realized_profit_usd,
        realizedRoi7dPercent: summary7d.pnl.realized_profit_percent,
        unrealizedPnl7dUsd: summary7d.pnl.unrealized_usd,
        totalPnl7dUsd: summary7d.pnl.total_usd,
        suspiciousTagCount,
      });
      if (historyReasons.length) {
        historyReasons.forEach((reason) => increment(rejectionReasons, reason));
        continue;
      }
      const summary24h = await getBirdeyeWalletSummary(seed.address, "24h");
      const averageBuyUsd = summary24h.cashflow_usd.total_invested / Math.max(1, summary24h.counts.total_buy);
      const metrics: SolanaSmartWalletMetrics = {
        trades24h: summary24h.counts.total_trade,
        buys24h: summary24h.counts.total_buy,
        invested24hUsd: summary24h.cashflow_usd.total_invested,
        invested7dUsd: summary7d.cashflow_usd.total_invested,
        uniqueTokens7d: summary7d.unique_tokens,
        closedTokens7d: closedTokens,
        winRate7d: normalizePercent(summary7d.counts.win_rate),
        realizedPnl7dUsd: summary7d.pnl.realized_profit_usd,
        realizedRoi7dPercent: summary7d.pnl.realized_profit_percent,
        unrealizedPnl7dUsd: summary7d.pnl.unrealized_usd,
        totalPnl7dUsd: summary7d.pnl.total_usd,
        averageBuyUsd,
        suspiciousTagCount,
      };
      const reasons = solanaSmartWalletRejectionReasons(metrics);
      if (reasons.length) {
        reasons.forEach((reason) => increment(rejectionReasons, reason));
        continue;
      }
      const scoring = calculateSolanaSmartWalletScore(metrics);
      if (scoring.score < MIN_DISCOVERY_SCORE) {
        increment(rejectionReasons, "low_score");
        continue;
      }
      const signatures = await solanaRpc<SignatureInfo[]>("getSignaturesForAddress", [seed.address, { limit: 10 }, "confirmed"]).catch(() => []);
      const validSignatures = signatures.filter((item) => item.signature && !item.err);
      const latestBlockTime = validSignatures.find((item) => item.blockTime)?.blockTime;
      const totalPnlPercent = summary7d.cashflow_usd.total_invested > 0
        ? summary7d.pnl.total_usd / summary7d.cashflow_usd.total_invested * 100
        : 0;
      candidates.push({
        address: seed.address,
        chainId: "solana",
        score: scoring.score,
        scoreBreakdown: scoring.breakdown,
        swapCount: summary24h.counts.total_trade,
        buyCount: summary24h.counts.total_buy,
        sellCount: summary24h.counts.total_sell,
        uniqueTokenCount: summary7d.unique_tokens,
        boughtUsd: summary7d.cashflow_usd.total_invested,
        soldUsd: summary7d.cashflow_usd.total_sold,
        currentValueUsd: summary7d.cashflow_usd.current_value,
        estimatedPnlUsd: summary7d.pnl.total_usd,
        estimatedPnlPercent: totalPnlPercent,
        gasCostUsd: 0,
        gainerTokens: tokenPerformances,
        lastActiveAt: latestBlockTime ? new Date(latestBlockTime * 1_000).toISOString() : new Date().toISOString(),
        sampleTxHashes: validSignatures.flatMap((item) => item.signature ? [item.signature] : []).slice(0, 3),
        qualityValidation: {
          windowDays: 7,
          swapCount: summary7d.counts.total_trade,
          buyCount: summary7d.counts.total_buy,
          sellCount: summary7d.counts.total_sell,
          uniqueTokenCount: summary7d.unique_tokens,
          completedRoundTrips: closedTokens,
          winRatePercent: metrics.winRate7d,
          realizedPnlUsd: summary7d.pnl.realized_profit_usd,
          realizedPnlPercent: summary7d.pnl.realized_profit_percent,
          unrealizedPnlUsd: summary7d.pnl.unrealized_usd,
          totalPnlUsd: summary7d.pnl.total_usd,
          investedUsd: summary7d.cashflow_usd.total_invested,
          averageBuyUsd,
          dataSource: "birdeye",
        },
      });
      if (candidates.length >= TARGET_CANDIDATES || candidates.length >= MAX_CANDIDATES) break;
    } catch (error) {
      providerErrorCount += 1;
      increment(rejectionReasons, `provider_${providerErrorReason(error)}`);
      continue;
    }
  }

  return {
    chainId: "solana",
    candidates: candidates.sort((left, right) => right.score - left.score || right.estimatedPnlUsd - left.estimatedPnlUsd),
    transferSampleSize: allTokenTraderGroups.reduce((total, group) => total + group.traders.length, 0),
    transactionSampleSize: candidates.reduce((total, candidate) => total + candidate.swapCount, 0),
    topGainers,
    pnlDataSource: "birdeye+helius+dexscreener",
    windowStartedAt,
    generatedAt: new Date().toISOString(),
    diagnostics: {
      status: providerErrorCount > 0 ? "partial" : "complete",
      tokenUniverseSize: tokenUniverse.length,
      tokenTraderRows: allTokenTraderGroups.reduce((total, group) => total + group.traders.length, 0),
      seedWallets: seeds.length,
      tokenLinkedWallets,
      pnlValidatedWallets,
      attemptedWallets,
      providerErrorCount,
      completionPercent: attemptedWallets ? Math.round(pnlValidatedWallets / attemptedWallets * 100) : 100,
      rejectionReasons,
    },
  };
}

function selectTokenCandidates(tokens: BirdeyeTokenListItem[]) {
  const byGain = [...tokens].sort((left, right) => right.price_change_24h_percent - left.price_change_24h_percent);
  const byVolume = [...tokens].sort((left, right) => right.volume_24h_usd - left.volume_24h_usd);
  const selected = new Map<string, BirdeyeTokenListItem>();
  for (const token of byGain.slice(0, TOP_GAINER_CANDIDATE_LIMIT / 2)) selected.set(token.address, token);
  for (const token of byVolume) {
    selected.set(token.address, token);
    if (selected.size >= TOP_GAINER_CANDIDATE_LIMIT) break;
  }
  return [...selected.values()];
}

function selectDiverseSeeds(seeds: WalletSeed[], limit: number) {
  const remaining = seeds.filter((seed) => seed.tokenTraders.size > 0);
  const selected: WalletSeed[] = [];
  const tokenUsage = new Map<string, number>();

  while (remaining.length && selected.length < limit) {
    remaining.sort((left, right) => {
      const leftUsage = averageTokenUsage(left, tokenUsage);
      const rightUsage = averageTokenUsage(right, tokenUsage);
      return leftUsage - rightUsage || seedPriority(right) - seedPriority(left);
    });
    const next = remaining.shift();
    if (!next) break;
    selected.push(next);
    for (const tokenAddress of next.tokenTraders.keys()) {
      tokenUsage.set(tokenAddress, (tokenUsage.get(tokenAddress) ?? 0) + 1);
    }
  }

  return selected;
}

function averageTokenUsage(seed: WalletSeed, usage: Map<string, number>) {
  const counts = [...seed.tokenTraders.keys()].map((address) => usage.get(address) ?? 0);
  return counts.reduce((total, count) => total + count, 0) / Math.max(1, counts.length);
}

function buildSeeds(
  groups: Array<{ token: DiscoveryGainerToken; traders: BirdeyeTokenTrader[] }>,
) {
  const seeds = new Map<string, WalletSeed>();
  const blockedAddresses = new Set<string>();
  for (const { token, traders } of groups) {
    for (const trader of traders) {
      if (!isValidAddress(trader.owner) || trader.trade < 2 || trader.trade > 50) continue;
      if (trader.tags.some((tag) => SUSPICIOUS_TAGS.has(tag.toLowerCase()))) {
        blockedAddresses.add(trader.owner);
        seeds.delete(trader.owner);
        continue;
      }
      if (blockedAddresses.has(trader.owner)) continue;
      const averageBuy = trader.volumeBuyUSD / Math.max(1, trader.tradeBuy);
      if (trader.volumeBuyUSD < 100 || averageBuy < 100 || averageBuy > 20_000 || trader.realizedPnl < 10) continue;
      const seed = seeds.get(trader.owner) ?? createSeed(trader.owner);
      trader.tags.forEach((tag) => seed.tags.add(tag.toLowerCase()));
      seed.tokenTraders.set(token.address, trader);
      seeds.set(trader.owner, seed);
    }
  }
  return [...seeds.values()].sort((left, right) => {
    return seedPriority(right) - seedPriority(left);
  });
}

function seedPriority(seed: WalletSeed) {
  const tokenScore = [...seed.tokenTraders.values()].reduce((total, trader) => (
    total + Math.max(0, trader.realizedPnl) + Math.max(0, trader.totalPnl) * 0.35 + Math.min(20_000, trader.volumeBuyUSD) * 0.01
  ), 0);
  return seed.tokenTraders.size * 500 + tokenScore;
}

function isUsableTokenTrader(trader: BirdeyeTokenTrader) {
  if (!isValidAddress(trader.owner) || trader.trade < 2 || trader.trade > 50) return false;
  if (trader.tags.some((tag) => SUSPICIOUS_TAGS.has(tag.toLowerCase()))) return false;
  const averageBuy = trader.volumeBuyUSD / Math.max(1, trader.tradeBuy);
  return trader.volumeBuyUSD >= 100 && averageBuy >= 100 && averageBuy <= 20_000 && trader.realizedPnl >= 10;
}

async function performancesFromDetails(address: string, topGainers: DiscoveryGainerToken[]) {
  const details = await getBirdeyeWalletTokenDetails(address, topGainers.map((token) => token.address));
  return details.map((detail) => performanceFromDetail(detail, topGainers)).filter(notNull)
    .filter((performance) => performance.buyCount > 0 && performance.boughtUsd >= 100);
}

function performanceFromTrader(row: BirdeyeTokenTrader, topGainers: DiscoveryGainerToken[]) {
  const market = topGainers.find((token) => token.address === row.tokenAddress);
  if (!market) return null;
  return {
    ...market,
    boughtUsd: row.volumeBuyUSD,
    soldUsd: row.volumeSellUSD,
    currentValueUsd: Math.max(0, row.volumeBuyUSD + row.totalPnl - row.volumeSellUSD),
    estimatedPnlUsd: row.totalPnl,
    gasCostUsd: 0,
    swapCount: row.trade,
    buyCount: row.tradeBuy,
    sellCount: row.tradeSell,
  } satisfies DiscoveryTokenPerformance;
}

function performanceFromDetail(detail: BirdeyeWalletTokenPnl, topGainers: DiscoveryGainerToken[]) {
  const market = topGainers.find((token) => token.address === detail.address);
  if (!market || detail.counts.total_buy <= 0) return null;
  return {
    ...market,
    boughtUsd: detail.cashflow_usd.total_invested,
    soldUsd: detail.cashflow_usd.total_sold,
    currentValueUsd: detail.cashflow_usd.current_value,
    estimatedPnlUsd: detail.pnl.total_usd,
    gasCostUsd: 0,
    swapCount: detail.counts.total_trade,
    buyCount: detail.counts.total_buy,
    sellCount: detail.counts.total_sell,
  } satisfies DiscoveryTokenPerformance;
}

function createSeed(address: string): WalletSeed {
  return { address, tags: new Set(), tokenTraders: new Map() };
}

function normalizePercent(value: number) {
  return value >= 0 && value <= 1 ? value * 100 : value;
}

function finiteBetween(value: number, minimum: number, maximum: number) {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isValidAddress(address: string) {
  try { return new PublicKey(address).toBase58() === address; } catch { return false; }
}

function notNull<T>(value: T | null): value is T {
  return value !== null;
}

function increment(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function providerErrorReason(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/compute units|usage limit|quota/i.test(message)) return "quota";
  if (/429|too many requests|rate limit/i.test(message)) return "rate_limit";
  if (/timeout|aborted/i.test(message)) return "timeout";
  return "request_error";
}

function emptyScan(windowStartedAt: string): WalletDiscoveryScan {
  return {
    chainId: "solana",
    candidates: [],
    transferSampleSize: 0,
    transactionSampleSize: 0,
    topGainers: [],
    pnlDataSource: "birdeye+helius+dexscreener",
    windowStartedAt,
    generatedAt: new Date().toISOString(),
    diagnostics: {
      status: "complete",
      tokenUniverseSize: 0,
      tokenTraderRows: 0,
      seedWallets: 0,
      tokenLinkedWallets: 0,
      pnlValidatedWallets: 0,
      attemptedWallets: 0,
      providerErrorCount: 0,
      completionPercent: 100,
      rejectionReasons: {},
    },
  };
}
