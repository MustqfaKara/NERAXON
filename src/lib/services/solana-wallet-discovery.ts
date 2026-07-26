import type { DiscoveryGainerToken, DiscoveryTokenPerformance, WalletDiscoveryCandidate, WalletDiscoveryScan } from "@/lib/domain/types";
import { calculateDiscoveryScore } from "@/lib/engine/discovery-scoring";
import { calculateMarkToMarketPnl, isSolanaDiscoveryWalletEligible, isSolanaTokenPerformanceEligible } from "@/lib/engine/discovery-pnl";
import { isStablecoinAsset } from "@/lib/engine/stablecoin-filter";
import { getEnhancedTransactions, type HeliusEnhancedTransaction } from "@/lib/solana/helius-client";
import { SOLANA_NATIVE_MINT } from "@/lib/solana/constants";
import { extractSolanaSwapMovement } from "@/lib/solana/swap-movement";
import { analyzeSolanaWalletHistory, calculateSolanaQualityEvidenceScore, type SolanaWalletQualityStats } from "@/lib/solana/wallet-quality";
import { getMarketDataProvider, type MarketSnapshot } from "@/lib/services/market-data-provider";
import { PublicKey } from "@solana/web3.js";
import { scanBirdeyeSolanaWallets } from "@/lib/services/solana-birdeye-discovery";
import { readCredentialSync } from "@/lib/security/credential-vault";
import { isBirdeyeCoolingDown, isBirdeyeQuotaError } from "@/lib/services/birdeye-api";
import { calculateSolanaFallbackScore } from "@/lib/engine/solana-fallback-quality";

const WINDOW_MS = 24 * 60 * 60 * 1_000;
const TOP_GAINER_LIMIT = 10;
const QUALITY_MARKET_LIMIT = 6;
const MIN_LIQUIDITY_USD = 10_000;
const MIN_FALLBACK_LIQUIDITY_USD = 2_500;
const MAX_DISCOVERY_SWAPS_24H = 50;
const TRANSACTION_PAGE_LIMIT = 100;
const DEFAULT_TRANSACTION_PAGES = 6;
const MEDIUM_VOLUME_TRANSACTION_PAGES = 8;
const HIGH_VOLUME_TRANSACTION_PAGES = 10;
const PAIR_TRANSACTION_PAGES = 4;
const GAINER_CACHE_TTL_MS = 2 * 60 * 1_000;
const SWAP_CACHE_TTL_MS = 10 * 60 * 1_000;
const QUALITY_SWAP_CACHE_TTL_MS = 30 * 60 * 1_000;
const QUALITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const QUALITY_CANDIDATE_LIMIT = 30;
const QUALITY_TRANSACTION_PAGES = 3;
const MIN_VALIDATED_DISCOVERY_SCORE = 58;

const DEX_REFERENCE_URLS = [
  "https://api.dexscreener.com/token-boosts/latest/v1",
  "https://api.dexscreener.com/token-boosts/top/v1",
  "https://api.dexscreener.com/token-profiles/latest/v1",
  "https://api.dexscreener.com/community-takeovers/latest/v1",
  "https://api.dexscreener.com/ads/latest/v1",
] as const;

const DEX_SEARCH_QUERIES = [
  "pumpswap",
  "pump.fun",
  "raydium",
  "launchlab",
  "meteora",
  "moonshot",
  "orca",
  "bonk",
  "believe",
  "SOL/USDC",
  "solana meme",
  "pump",
  "solana cat",
  "solana dog",
  "solana ai",
] as const;

interface DexTokenReference { chainId?: string; tokenAddress?: string }
interface DexSearchPair { chainId?: string; baseToken?: { address?: string } }
interface TokenFlow {
  market: DiscoveryGainerToken;
  boughtUsd: number;
  soldUsd: number;
  tokenBoughtAmount: number;
  tokenSoldAmount: number;
  tokenBalance: number;
  gasCostUsd: number;
  buyCount: number;
  sellCount: number;
  hashes: Set<string>;
}
interface WalletFlow { address: string; flows: Map<string, TokenFlow>; lastActiveAt: string }

interface SolanaMarketUniverse {
  displayMarkets: DiscoveryGainerToken[];
  discoveryMarkets: DiscoveryGainerToken[];
}

let gainerCache: { expiresAt: number; value: SolanaMarketUniverse } | null = null;
const globalSolanaDiscoveryState = globalThis as typeof globalThis & {
  __neraxonSolanaSwapCache?: Map<string, { expiresAt: number; transactions: HeliusEnhancedTransaction[] }>;
};
const swapCache = globalSolanaDiscoveryState.__neraxonSolanaSwapCache
  ?? new Map<string, { expiresAt: number; transactions: HeliusEnhancedTransaction[] }>();
globalSolanaDiscoveryState.__neraxonSolanaSwapCache = swapCache;

export async function scanSolanaWallets(): Promise<WalletDiscoveryScan> {
  if (readCredentialSync("birdeye-api-key") && !isBirdeyeCoolingDown()) {
    try {
      const scan = await scanBirdeyeSolanaWallets();
      if ((scan.diagnostics?.rejectionReasons.provider_quota ?? 0) > 0) {
        return await fallbackFromPartialBirdeyeScan(scan);
      }
      return scan;
    } catch (error) {
      if (!isBirdeyeQuotaError(error)) throw error;
      return scanLegacySolanaWallets();
    }
  }
  return scanLegacySolanaWallets();
}

async function fallbackFromPartialBirdeyeScan(partialScan: WalletDiscoveryScan) {
  try {
    return await scanLegacySolanaWallets();
  } catch {
    return partialScan;
  }
}

async function scanLegacySolanaWallets(): Promise<WalletDiscoveryScan> {
  const windowStartedAt = new Date(Date.now() - WINDOW_MS).toISOString();
  const marketProvider = getMarketDataProvider();
  const marketUniverse = await discoverSolanaMarketUniverse();
  if (!marketUniverse.discoveryMarkets.length) return emptyScan(windowStartedAt);
  const solMarkets = await marketProvider.getTokenMarkets("solana", [SOLANA_NATIVE_MINT]);
  const solPriceUsd = solMarkets[0]?.priceUsd ?? 0;
  const wallets = new Map<string, WalletFlow>();
  let transactionSampleSize = 0;
  const scanResults = await mapWithConcurrency(marketUniverse.discoveryMarkets, 2, async (market) => {
    try {
      return {
        market,
        transactions: await getMarketSwaps(market, Date.now() - WINDOW_MS),
        error: null,
      };
    } catch (error) {
      return { market, transactions: [] as HeliusEnhancedTransaction[], error };
    }
  });
  const successfulQueries = scanResults.filter((result) => !result.error);
  if (!successfulQueries.length) throw scanResults.find((result) => result.error)?.error;
  const scannedGainers = successfulQueries.map((result) => result.market);

  for (const { market, transactions } of successfulQueries) {
    const recent = transactions.filter((transaction) => (transaction.timestamp ?? 0) * 1_000 >= Date.now() - WINDOW_MS);
    transactionSampleSize += recent.length;
    for (const transaction of recent) accumulateTransaction(wallets, market, transaction, solPriceUsd);
  }

  const rejectionReasons: Record<string, number> = {};
  const seedCandidates = [...wallets.values()]
    .map((wallet) => finalizeCandidate(wallet, rejectionReasons))
    .filter((candidate): candidate is WalletDiscoveryCandidate => Boolean(candidate))
    .filter((candidate) => {
      const eligible = candidate.swapCount <= MAX_DISCOVERY_SWAPS_24H;
      if (!eligible) increment(rejectionReasons, "high_activity");
      return eligible;
    })
    .sort((left, right) => right.estimatedPnlUsd - left.estimatedPnlUsd || right.score - left.score);
  const quality = await validateCandidateQuality(seedCandidates, solPriceUsd, rejectionReasons);
  const candidates = quality.candidates.filter((candidate) => {
    const eligible = candidate.score >= MIN_VALIDATED_DISCOVERY_SCORE;
    if (!eligible) recordQualityRejection(candidate, rejectionReasons);
    return eligible;
  });
  const failedMarketQueries = scanResults.length - successfulQueries.length;
  if (failedMarketQueries) rejectionReasons.provider_request_error = failedMarketQueries;
  const transferSampleSize = [...wallets.values()].reduce(
    (total, wallet) => total + [...wallet.flows.values()].reduce((sum, flow) => sum + flow.hashes.size, 0),
    0,
  );

  return {
    chainId: "solana",
    candidates,
    transferSampleSize,
    transactionSampleSize,
    topGainers: marketUniverse.displayMarkets.filter((market) => (
      scannedGainers.some((scannedMarket) => scannedMarket.address === market.address)
    )),
    pnlDataSource: "helius+dexscreener",
    windowStartedAt,
    generatedAt: new Date().toISOString(),
    diagnostics: {
      status: failedMarketQueries ? "partial" : "complete",
      tokenUniverseSize: scannedGainers.length,
      tokenTraderRows: transferSampleSize,
      seedWallets: wallets.size,
      tokenLinkedWallets: seedCandidates.length,
      pnlValidatedWallets: quality.validatedCount,
      attemptedWallets: quality.attemptedCount,
      providerErrorCount: failedMarketQueries,
      completionPercent: quality.attemptedCount
        ? Math.round(quality.validatedCount / quality.attemptedCount * 100)
        : 100,
      qualityScoreRange: summarizeScores(quality.candidates),
      rejectionReasons,
    },
  };
}

async function discoverSolanaMarketUniverse(): Promise<SolanaMarketUniverse> {
  if (gainerCache && gainerCache.expiresAt > Date.now()) return gainerCache.value;
  const [referenceGroups, searchGroups] = await Promise.all([
    Promise.allSettled(DEX_REFERENCE_URLS.map(fetchDexReferences)),
    Promise.allSettled(DEX_SEARCH_QUERIES.map(fetchDexSearch)),
  ]);
  const references = [...fulfilledValues(referenceGroups).flat(), ...fulfilledValues(searchGroups).flat()];
  const addresses = [...new Set(references
    .filter((item) => item.chainId === "solana" && item.tokenAddress)
    .map((item) => item.tokenAddress!)
    .filter(isValidSolanaAddress))].slice(0, 600);
  const markets = await getMarketDataProvider().getTokenMarkets("solana", addresses);
  const eligibleMarkets = markets
    .filter((market) => !isStablecoinAsset("solana", market.tokenAddress, market.tokenSymbol))
    .filter((market) => market.priceChange24hPercent > 0 && market.priceChange24hPercent <= 1_000)
    .sort((left, right) => right.priceChange24hPercent - left.priceChange24hPercent);
  const strictMarkets = eligibleMarkets.filter((market) => market.liquidityUsd >= MIN_LIQUIDITY_USD && market.volume24hUsd >= 5_000);
  const fallbackMarkets = eligibleMarkets.filter((market) => (
    market.liquidityUsd >= MIN_FALLBACK_LIQUIDITY_USD
    && market.liquidityUsd < MIN_LIQUIDITY_USD
    && market.volume24hUsd >= 5_000
  ));
  const reserveMarkets = eligibleMarkets.filter((market) => (
    market.liquidityUsd >= 1_000
    && market.volume24hUsd >= 1_000
    && !strictMarkets.includes(market)
    && !fallbackMarkets.includes(market)
  ));
  const discoveryReserveMarkets = eligibleMarkets.filter((market) => (
    !strictMarkets.includes(market)
    && !fallbackMarkets.includes(market)
    && !reserveMarkets.includes(market)
  ));
  const rankedMarkets = [...strictMarkets, ...fallbackMarkets, ...reserveMarkets, ...discoveryReserveMarkets];
  const displayMarkets = rankedMarkets.slice(0, TOP_GAINER_LIMIT).map(toGainer);
  const displayAddresses = new Set(displayMarkets.map((market) => market.address));
  const qualityMarkets = strictMarkets
    .filter((market) => !displayAddresses.has(market.tokenAddress))
    .filter((market) => (
      market.priceChange24hPercent >= 10
      && market.priceChange24hPercent <= 300
      && market.volume24hUsd >= 25_000
    ))
    .sort((left, right) => marketDiscoveryRank(right) - marketDiscoveryRank(left))
    .slice(0, QUALITY_MARKET_LIMIT)
    .map(toGainer);
  const value = {
    displayMarkets,
    discoveryMarkets: [...displayMarkets, ...qualityMarkets],
  };
  gainerCache = { expiresAt: Date.now() + GAINER_CACHE_TTL_MS, value };
  return value;
}

function marketDiscoveryRank(market: MarketSnapshot) {
  const gainQuality = 100 - Math.min(100, Math.abs(market.priceChange24hPercent - 100) * 0.5);
  const liquidityQuality = Math.min(100, Math.log10(Math.max(1, market.liquidityUsd)) * 20);
  const volumeQuality = Math.min(100, Math.log10(Math.max(1, market.volume24hUsd)) * 16);
  return gainQuality * 0.4 + liquidityQuality * 0.3 + volumeQuality * 0.3;
}

async function fetchDexReferences(url: string) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000), cache: "no-store" });
  if (!response.ok) throw new Error(`DexScreener Solana token evreni alınamadı (${response.status}).`);
  return response.json() as Promise<DexTokenReference[]>;
}

async function fetchDexSearch(query: string): Promise<DexTokenReference[]> {
  const response = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`DexScreener Solana piyasa araması başarısız (${response.status}).`);
  const payload = await response.json() as { pairs?: DexSearchPair[] };
  return (payload.pairs ?? []).map((pair) => ({ chainId: pair.chainId, tokenAddress: pair.baseToken?.address }));
}

async function getRecentSwaps(
  address: string,
  windowStartedAt: number,
  maxPages: number,
  cacheTtlMs = SWAP_CACHE_TTL_MS,
) {
  const windowLabel = windowStartedAt < Date.now() - 2 * WINDOW_MS ? "7d" : "24h";
  const cacheKey = `${address}:${windowLabel}:${maxPages}`;
  const cached = swapCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.transactions.filter((transaction) => (transaction.timestamp ?? 0) * 1_000 >= windowStartedAt);
  }
  if (cached) swapCache.delete(cacheKey);
  const transactions: HeliusEnhancedTransaction[] = [];
  let before: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const batch = await getEnhancedTransactions(address, { before, limit: TRANSACTION_PAGE_LIMIT, type: "SWAP" });
    transactions.push(...batch);
    const oldest = batch.at(-1);
    if (!batch.length || !oldest?.signature || (oldest.timestamp ?? 0) * 1_000 < windowStartedAt) break;
    before = oldest.signature;
  }
  const uniqueTransactions = [...new Map(transactions.map((transaction) => [transaction.signature, transaction])).values()];
  swapCache.set(cacheKey, { expiresAt: Date.now() + cacheTtlMs, transactions: uniqueTransactions });
  return uniqueTransactions;
}

async function getMarketSwaps(market: DiscoveryGainerToken, windowStartedAt: number) {
  const mintTransactions = await getRecentSwaps(
    market.address,
    windowStartedAt,
    transactionPageBudget(market),
  );
  if (!market.pairAddress || market.pairAddress === market.address) return mintTransactions;
  const pairTransactions = await getRecentSwaps(
    market.pairAddress,
    windowStartedAt,
    PAIR_TRANSACTION_PAGES,
  ).catch(() => []);
  return [...new Map(
    [...mintTransactions, ...pairTransactions].map((transaction) => [transaction.signature, transaction]),
  ).values()];
}

function transactionPageBudget(market: DiscoveryGainerToken) {
  if (market.volume24hUsd >= 1_000_000) return HIGH_VOLUME_TRANSACTION_PAGES;
  if (market.volume24hUsd >= 500_000) return MEDIUM_VOLUME_TRANSACTION_PAGES;
  return DEFAULT_TRANSACTION_PAGES;
}

async function validateCandidateQuality(
  candidates: WalletDiscoveryCandidate[],
  solPriceUsd: number,
  rejectionReasons: Record<string, number>,
) {
  const shortlist = candidates.slice(0, QUALITY_CANDIDATE_LIMIT);
  const validations = await mapWithConcurrency(shortlist, 2, async (candidate) => {
    try {
      const windowStartedAt = Date.now() - QUALITY_WINDOW_MS;
      const transactions = await getRecentSwaps(
        candidate.address,
        windowStartedAt,
        QUALITY_TRANSACTION_PAGES,
        QUALITY_SWAP_CACHE_TTL_MS,
      );
      const oldestTimestamp = Math.min(...transactions
        .map((transaction) => (transaction.timestamp ?? 0) * 1_000)
        .filter((timestamp) => timestamp > 0));
      const reachedPageEnd = transactions.length < QUALITY_TRANSACTION_PAGES * TRANSACTION_PAGE_LIMIT;
      const reachedWindowStart = Number.isFinite(oldestTimestamp) && oldestTimestamp <= windowStartedAt;
      return {
        stats: analyzeSolanaWalletHistory(transactions, candidate.address, solPriceUsd),
        historyComplete: reachedPageEnd || reachedWindowStart,
      };
    } catch {
      return null;
    }
  });
  const validationByAddress = new Map(shortlist.map((candidate, index) => [candidate.address, validations[index]]));
  let validatedCount = 0;
  const rankedCandidates = candidates.map((candidate) => {
    const validation = validationByAddress.get(candidate.address);
    const stats = validation?.stats;
    if (stats && stats.swapCount >= 2) validatedCount += 1;
    if (!validation) increment(rejectionReasons, "history_unavailable");
    else if (stats!.swapCount < 2) increment(rejectionReasons, "insufficient_history");
    else if (!validation.historyComplete) increment(rejectionReasons, "history_truncated");
    if (!validation || !validation.historyComplete || stats!.completedRoundTrips === 0) {
      const provisionalScore = calculateSolanaFallbackScore({
        candidateScore: candidate.score,
        estimatedPnlUsd: candidate.estimatedPnlUsd,
        estimatedPnlPercent: candidate.estimatedPnlPercent,
        swapCount24h: candidate.swapCount,
        historySwapCount: stats?.swapCount ?? 0,
        historySellCount: stats?.sellCount ?? 0,
        completedRoundTrips: validation?.historyComplete ? stats?.completedRoundTrips ?? 0 : 0,
      });
      if (provisionalScore === null) return { ...candidate, score: Math.min(candidate.score, 55) };
      increment(rejectionReasons, "provisional_candidate");
      return {
        ...candidate,
        score: provisionalScore,
        qualityValidation: stats ? {
          ...toHeliusQualityValidation(stats, validation?.historyComplete ?? false),
          dataSource: "helius-provisional" as const,
        } : undefined,
      };
    }
    return applyQualityScore(candidate, stats!);
  }).sort((left, right) => right.score - left.score || right.estimatedPnlUsd - left.estimatedPnlUsd);
  return { candidates: rankedCandidates, attemptedCount: shortlist.length, validatedCount };
}

function applyQualityScore(candidate: WalletDiscoveryCandidate, validation: SolanaWalletQualityStats): WalletDiscoveryCandidate {
  const hasClosedEvidence = validation.completedRoundTrips > 0;
  const effectivePnlPercent = hasClosedEvidence
    ? candidate.estimatedPnlPercent * 0.55 + validation.realizedPnlPercent * 0.45
    : candidate.estimatedPnlPercent * 0.7;
  const effectivePnlUsd = candidate.estimatedPnlUsd + validation.realizedPnlUsd;
  const scoring = calculateDiscoveryScore({
    swapCount: validation.swapCount,
    buyCount: validation.buyCount,
    sellCount: validation.sellCount,
    uniqueTokenCount: validation.uniqueTokenCount,
    ageMinutes: Math.max(0, (Date.now() - new Date(candidate.lastActiveAt).getTime()) / 60_000),
    estimatedPnlPercent: effectivePnlPercent,
    boughtUsd: candidate.boughtUsd,
    estimatedPnlUsd: effectivePnlUsd,
  });
  const evidenceScore = calculateSolanaQualityEvidenceScore(validation);
  let finalScore = validation.completedRoundTrips
    ? scoring.score * 0.45 + evidenceScore * 0.55
    : Math.min(55, scoring.score * 0.75);
  if (validation.realizedPnlUsd < 0) finalScore *= 0.65;
  if (validation.completedRoundTrips >= 2 && validation.winRatePercent < 40) finalScore *= 0.85;
  if (validation.swapCount > 120 || validation.uniqueTokenCount > 20) finalScore *= 0.75;
  return {
    ...candidate,
    score: Math.max(0, Math.min(100, Math.round(finalScore))),
    scoreBreakdown: scoring.breakdown,
    qualityValidation: {
      ...toHeliusQualityValidation(validation),
    },
  };
}

function toHeliusQualityValidation(validation: SolanaWalletQualityStats, historyComplete = true) {
  return {
    windowDays: 7,
    swapCount: validation.swapCount,
    buyCount: validation.buyCount,
    sellCount: validation.sellCount,
    uniqueTokenCount: validation.uniqueTokenCount,
    completedRoundTrips: validation.completedRoundTrips,
    winRatePercent: validation.winRatePercent,
    realizedPnlUsd: validation.realizedPnlUsd,
    realizedPnlPercent: validation.realizedPnlPercent,
    historyComplete,
    dataSource: "helius" as const,
  };
}

function accumulateTransaction(
  wallets: Map<string, WalletFlow>,
  market: DiscoveryGainerToken,
  transaction: HeliusEnhancedTransaction,
  solPriceUsd: number,
) {
  const movement = extractSolanaSwapMovement(transaction, market.address, solPriceUsd);
  if (!movement) return;
  const timestamp = new Date((transaction.timestamp ?? Math.floor(Date.now() / 1_000)) * 1_000).toISOString();
  const wallet = wallets.get(movement.wallet) ?? { address: movement.wallet, flows: new Map(), lastActiveAt: timestamp };
  const flow = wallet.flows.get(market.address) ?? createFlow(market);
  const fallbackNotionalUsd = movement.tokenAmount * estimateEntryPrice(market, timestamp);
  const notionalUsd = movement.notionalUsd > 0 ? movement.notionalUsd : fallbackNotionalUsd;
  if (movement.direction === "buy") {
    flow.boughtUsd += notionalUsd;
    flow.tokenBoughtAmount += movement.tokenAmount;
    flow.tokenBalance += movement.tokenAmount;
    flow.buyCount += 1;
  } else {
    flow.soldUsd += notionalUsd;
    flow.tokenSoldAmount += movement.tokenAmount;
    flow.tokenBalance -= movement.tokenAmount;
    flow.sellCount += 1;
  }
  flow.gasCostUsd += Math.max(0, Number(transaction.fee ?? 0)) / 1_000_000_000 * solPriceUsd;
  flow.hashes.add(transaction.signature);
  wallet.flows.set(market.address, flow);
  if (timestamp > wallet.lastActiveAt) wallet.lastActiveAt = timestamp;
  wallets.set(movement.wallet, wallet);
}

function finalizeCandidate(wallet: WalletFlow, rejectionReasons: Record<string, number>): WalletDiscoveryCandidate | null {
  const gainerTokens: DiscoveryTokenPerformance[] = [...wallet.flows.values()]
    .filter((flow) => flow.tokenSoldAmount <= flow.tokenBoughtAmount * 1.02)
    .map((flow) => {
    const currentValueUsd = Math.max(0, flow.tokenBalance) * flow.market.priceUsd;
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
  }).filter(isSolanaTokenPerformanceEligible);
  if (!gainerTokens.length) {
    increment(rejectionReasons, "no_profitable_token");
    return null;
  }
  const boughtUsd = sum(gainerTokens.map((token) => token.boughtUsd));
  const soldUsd = sum(gainerTokens.map((token) => token.soldUsd));
  const currentValueUsd = sum(gainerTokens.map((token) => token.currentValueUsd));
  const gasCostUsd = sum(gainerTokens.map((token) => token.gasCostUsd));
  const estimatedPnlUsd = soldUsd + currentValueUsd - boughtUsd - gasCostUsd;
  const { estimatedPnlPercent } = calculateMarkToMarketPnl(boughtUsd, soldUsd - gasCostUsd, currentValueUsd);
  const hashes = new Set(gainerTokens.flatMap((token) => [...(wallet.flows.get(token.address)?.hashes ?? [])]));
  const buyCount = sum(gainerTokens.map((token) => token.buyCount));
  const sellCount = sum(gainerTokens.map((token) => token.sellCount));
  if (!isSolanaDiscoveryWalletEligible({ boughtUsd, soldUsd, currentValueUsd, estimatedPnlUsd, estimatedPnlPercent, swapCount: hashes.size })) {
    increment(rejectionReasons, "wallet_financial_filter");
    return null;
  }
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
    chainId: "solana",
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

function createFlow(market: DiscoveryGainerToken): TokenFlow {
  return {
    market,
    boughtUsd: 0,
    soldUsd: 0,
    tokenBoughtAmount: 0,
    tokenSoldAmount: 0,
    tokenBalance: 0,
    gasCostUsd: 0,
    buyCount: 0,
    sellCount: 0,
    hashes: new Set(),
  };
}

function estimateEntryPrice(market: DiscoveryGainerToken, timestamp: string) {
  const ageFraction = Math.min(1, Math.max(0, (Date.now() - new Date(timestamp).getTime()) / WINDOW_MS));
  return market.priceUsd / Math.max(0.01, 1 + market.priceChange24hPercent * ageFraction / 100);
}

function toGainer(market: MarketSnapshot): DiscoveryGainerToken {
  return { address: market.tokenAddress, symbol: market.tokenSymbol, priceUsd: market.priceUsd, priceChange24hPercent: market.priceChange24hPercent, liquidityUsd: market.liquidityUsd, volume24hUsd: market.volume24hUsd, marketCapUsd: market.marketCapUsd, pairAddress: market.pairAddress, dexId: market.dexId };
}

function emptyScan(windowStartedAt: string): WalletDiscoveryScan {
  return { chainId: "solana", candidates: [], transferSampleSize: 0, transactionSampleSize: 0, topGainers: [], pnlDataSource: "helius+dexscreener", windowStartedAt, generatedAt: new Date().toISOString() };
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

function increment(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function recordQualityRejection(
  candidate: WalletDiscoveryCandidate,
  rejectionReasons: Record<string, number>,
) {
  increment(rejectionReasons, "low_score");
  const quality = candidate.qualityValidation;
  if (!quality) {
    increment(rejectionReasons, "missing_quality_evidence");
    return;
  }
  if (quality.realizedPnlUsd < 0) increment(rejectionReasons, "negative_7d_realized_pnl");
  if (quality.completedRoundTrips < 2) increment(rejectionReasons, "low_roundtrip_evidence");
  if (quality.completedRoundTrips >= 2 && quality.winRatePercent < 40) {
    increment(rejectionReasons, "low_7d_win_rate");
  }
  if (quality.swapCount > 120 || quality.uniqueTokenCount > 20) {
    increment(rejectionReasons, "overactive_7d_history");
  }
}

function summarizeScores(candidates: WalletDiscoveryCandidate[]) {
  if (!candidates.length) return { minimum: 0, maximum: 0, average: 0 };
  const scores = candidates.map((candidate) => candidate.score);
  return {
    minimum: Math.min(...scores),
    maximum: Math.max(...scores),
    average: Math.round(sum(scores) / scores.length),
  };
}

function isValidSolanaAddress(address: string) {
  try {
    return new PublicKey(address).toBase58() === address;
  } catch {
    return false;
  }
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

function fulfilledValues<T>(results: PromiseSettledResult<T>[]) {
  return results
    .filter((result): result is PromiseFulfilledResult<T> => result.status === "fulfilled")
    .map((result) => result.value);
}
