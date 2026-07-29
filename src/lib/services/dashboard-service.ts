import type { DashboardSnapshot } from "@/lib/domain/types";
import { store } from "@/lib/repositories/store";
import { getMarketDataProvider } from "@/lib/services/market-data-provider";
import { getChainAdapter } from "@/lib/chains/registry";
import { getConsensusEntries, getPerformanceAnalytics } from "@/lib/services/analytics-service";
import { listServiceHealth, monitorService } from "@/lib/services/service-health";
import { calculateHypercorePnl } from "@/lib/engine/hypercore-position";
import { findHypercoreMarket, getHypercoreMarkets } from "@/lib/services/hypercore-api";
import { getLiveReadiness } from "@/lib/services/live-readiness";
import { getShadowPortfolio, refreshExecutionMarkets } from "@/lib/services/execution-accounting";
import { calculateExecutionQuality } from "@/lib/engine/execution-quality";
import { getLivePortfolio, getLivePortfolioBestEffort } from "@/lib/services/live-equity";
import type { DashboardViewId } from "@/lib/dashboard-pages";
import { LIVE_PILOT_INTEGRATION_IDS } from "@/lib/domain/integrations";
import { EVM_CHAIN_IDS } from "@/lib/domain/defaults";
import { listEvmRpcEndpoints } from "@/lib/chains/evm-rpc-pool";

let cachedLivePortfolio: DashboardSnapshot["livePortfolio"] = [];

export async function refreshDashboardMarkets(view?: DashboardViewId): Promise<DashboardSnapshot> {
  await refreshChainHealth();
  const positions = store.listPositions();
  const hypercorePositions = store.listHypercorePositions();

  const marketProvider = getMarketDataProvider();
  const chainIds = [...new Set(positions.map((position) => position.chainId))];
  const results = await Promise.allSettled(chainIds.map(async (chainId) => {
    const chainPositions = positions.filter((position) => position.chainId === chainId);
    const markets = await marketProvider.getTokenMarkets(
      chainId,
      chainPositions.map((position) => position.tokenAddress),
      { forceRefresh: true },
    );
    const marketByAddress = new Map(markets.map((market) => [market.tokenAddress.toLowerCase(), market]));
    const updatedAt = new Date().toISOString();
    let updatedCount = 0;

    for (const position of chainPositions) {
      const market = marketByAddress.get(position.tokenAddress.toLowerCase());
      if (!market) continue;
      store.upsertPosition({
        ...position,
        tokenSymbol: market.tokenSymbol || position.tokenSymbol,
        pairAddress: market.pairAddress,
        currentPriceUsd: market.priceUsd,
        unrealizedPnlUsd: position.quantity * market.priceUsd - position.investedUsd,
        updatedAt,
      });
      updatedCount += 1;
    }
    return updatedCount;
  }));

  if (hypercorePositions.length) {
    const markets = await getHypercoreMarkets();
    for (const position of hypercorePositions) {
      const market = findHypercoreMarket(markets, position.marketType, position.coin);
      if (!market) continue;
      store.upsertHypercorePosition({
        ...position,
        currentPriceUsd: market.priceUsd,
        unrealizedPnlUsd: calculateHypercorePnl(position.side, position.entryPriceUsd, market.priceUsd, position.quantity),
        updatedAt: new Date().toISOString(),
      });
    }
  }
  const executionMode = store.getMode();
  if (executionMode !== "paper") await refreshExecutionMarkets(executionMode);

  const updatedCount = results.reduce(
    (total, result) => total + (result.status === "fulfilled" ? result.value : 0),
    0,
  );
  if (positions.length > 0 && updatedCount === 0) {
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    throw failure?.reason instanceof Error
      ? failure.reason
      : new Error("Açık pozisyonlar için güncel piyasa fiyatı bulunamadı.");
  }

  return view ? getDashboardSnapshotForView(view, true) : getDashboardSnapshotForApi();
}

async function refreshChainHealth() {
  await Promise.all(store.listChains().map(async (chain) => {
    try {
      const health = await monitorService(`${chain.id}_rpc`, () => getChainAdapter(chain.id).checkHealth());
      store.updateChain(chain.id, {
        lastBlock: health.blockNumber,
        latencyMs: health.latencyMs,
        errorMessage: null,
      });
    } catch (error) {
      store.updateChain(chain.id, {
        latencyMs: null,
        errorMessage: error instanceof Error ? error.message : "RPC gecikmesi ölçülemedi.",
      });
    }
  }));
}

export function getDashboardSnapshot(): DashboardSnapshot {
  store.expirePreparingExecutionAttempts();
  store.repairLegacyDiscoveryScores();
  store.repairInvalidSolanaWallets();
  const positionLots = store.listPositionLots();
  const positions = enrichPositionsWithSources(store.listPositions(), positionLots);
  const trades = store.listTrades();
  const hypercorePositions = store.listHypercorePositions();
  const hypercoreTrades = store.listHypercoreTrades();
  let startingBalanceUsd = store.getStartingBalance();
  let cashBalanceUsd = store.getCashBalance();
  const positionValue = positions.reduce((sum, position) => sum + position.quantity * position.currentPriceUsd, 0);
  const hypercoreValue = hypercorePositions.reduce((sum, position) => sum + position.marginUsd + position.unrealizedPnlUsd - position.fundingUsd, 0);
  let unrealizedPnlUsd = positions.reduce((sum, position) => sum + position.unrealizedPnlUsd, 0)
    + hypercorePositions.reduce((sum, position) => sum + position.unrealizedPnlUsd - position.fundingUsd, 0);
  let equityUsd = cashBalanceUsd + positionValue + hypercoreValue;
  let totalFeesUsd = store.getTotalTradeFeesUsd() + store.getHypercoreFeesUsd();
  let realizedPnlUsd = equityUsd - startingBalanceUsd - unrealizedPnlUsd;
  const mode = store.getMode();
  const shadowPortfolio = getShadowPortfolio();
  if (mode === "shadow" && shadowPortfolio.length) {
    startingBalanceUsd = shadowPortfolio.reduce((sum, account) => sum + account.startingEquityUsd, 0);
    cashBalanceUsd = shadowPortfolio.reduce((sum, account) => sum + account.cashBalanceUsd, 0);
    equityUsd = shadowPortfolio.reduce((sum, account) => sum + account.equityUsd, 0);
    realizedPnlUsd = shadowPortfolio.reduce((sum, account) => sum + account.realizedPnlUsd, 0);
    unrealizedPnlUsd = shadowPortfolio.reduce((sum, account) => sum + account.unrealizedPnlUsd, 0);
    totalFeesUsd = shadowPortfolio.reduce((sum, account) => sum + account.totalCostsUsd, 0);
  }
  const today = new Date().toISOString().slice(0, 10);
  if (store.getDailyStartDate() !== today) {
    store.setDailyStartDate(today);
    store.setDailyStartEquity(equityUsd);
  }
  const dailyPnlUsd = mode === "shadow" && shadowPortfolio.length
    ? shadowPortfolio.reduce((sum, account) => sum + account.equityUsd - account.dailyStartEquityUsd, 0)
    : equityUsd - store.getDailyStartEquity();

  const executionAttempts = store.listExecutionAttempts();
  return {
    language: store.getLanguage(),
    mode,
    liveReadiness: getLiveReadiness(),
    startingBalanceUsd,
    cashBalanceUsd,
    equityUsd,
    realizedPnlUsd,
    unrealizedPnlUsd,
    totalFeesUsd,
    dailyPnlUsd,
    chains: store.listChains(),
    wallets: store.listWallets(),
    positions,
    positionLots,
    trades,
    events: store.listEvents(),
    riskSettings: store.getRiskSettings(),
    circuitBreaker: store.getCircuitBreaker(),
    analytics: getPerformanceAnalytics(),
    consensus: getConsensusEntries(),
    aiAdvisories: store.listAiTradeAdvisories(),
    serviceHealth: listServiceHealth(),
    rpcEndpoints: EVM_CHAIN_IDS.flatMap(listEvmRpcEndpoints),
    hypercorePositions,
    hypercoreTrades,
    executionLots: store.listExecutionLots(),
    executionAttempts,
    executionQuality: calculateExecutionQuality(executionAttempts, mode),
    shadowPortfolio,
    livePortfolio: [],
    livePortfolioComplete: false,
    executionAccounts: store.getExecutionAccounts(),
    reconciliation: store.listReconciliation(),
    certificationSteps: store.listCertificationSteps(),
  };
}

export async function getDashboardSnapshotForApi(): Promise<DashboardSnapshot> {
  const snapshot = getDashboardSnapshot();
  if (snapshot.mode !== "live") return snapshot;
  const livePortfolio = await getLivePortfolio();
  return {
    ...snapshot,
    startingBalanceUsd: livePortfolio.reduce((sum, account) => sum + account.startingEquityUsd, 0),
    cashBalanceUsd: livePortfolio.reduce((sum, account) => sum + account.cashBalanceUsd, 0),
    equityUsd: livePortfolio.reduce((sum, account) => sum + account.equityUsd, 0),
    realizedPnlUsd: livePortfolio.reduce((sum, account) => sum + account.realizedPnlUsd, 0),
    unrealizedPnlUsd: livePortfolio.reduce((sum, account) => sum + account.unrealizedPnlUsd, 0),
    totalFeesUsd: livePortfolio.reduce((sum, account) => sum + account.totalCostsUsd, 0),
    dailyPnlUsd: livePortfolio.reduce((sum, account) => sum + account.equityUsd - account.dailyStartEquityUsd, 0),
    livePortfolio,
    livePortfolioComplete: LIVE_PILOT_INTEGRATION_IDS.every((chainId) => livePortfolio.some((account) => account.integrationId === chainId)),
  };
}

export async function getDashboardSnapshotForView(
  view: DashboardViewId,
  includeLivePortfolio = false,
): Promise<DashboardSnapshot> {
  const snapshot = getDashboardSnapshot();
  const needsLivePortfolio = snapshot.mode === "live" && (view === "overview" || view === "my-wallets" || view === "wallets");
  if (includeLivePortfolio && needsLivePortfolio) {
    const refreshedPortfolio = await getLivePortfolioBestEffort();
    if (refreshedPortfolio.length) cachedLivePortfolio = mergeLivePortfolio(cachedLivePortfolio, refreshedPortfolio);
  }
  const withPortfolio = needsLivePortfolio && cachedLivePortfolio.length
    ? applyLivePortfolio(snapshot, cachedLivePortfolio)
    : snapshot;
  return scopeDashboardSnapshot(withPortfolio, view);
}

function mergeLivePortfolio(
  previous: DashboardSnapshot["livePortfolio"],
  refreshed: DashboardSnapshot["livePortfolio"],
): DashboardSnapshot["livePortfolio"] {
  const byIntegration = new Map(previous.map((account) => [account.integrationId, account]));
  for (const account of refreshed) byIntegration.set(account.integrationId, account);
  return [...byIntegration.values()];
}

function applyLivePortfolio(
  snapshot: DashboardSnapshot,
  livePortfolio: DashboardSnapshot["livePortfolio"],
): DashboardSnapshot {
  return {
    ...snapshot,
    startingBalanceUsd: livePortfolio.reduce((sum, account) => sum + account.startingEquityUsd, 0),
    cashBalanceUsd: livePortfolio.reduce((sum, account) => sum + account.cashBalanceUsd, 0),
    equityUsd: livePortfolio.reduce((sum, account) => sum + account.equityUsd, 0),
    realizedPnlUsd: livePortfolio.reduce((sum, account) => sum + account.realizedPnlUsd, 0),
    unrealizedPnlUsd: livePortfolio.reduce((sum, account) => sum + account.unrealizedPnlUsd, 0),
    totalFeesUsd: livePortfolio.reduce((sum, account) => sum + account.totalCostsUsd, 0),
    dailyPnlUsd: livePortfolio.reduce((sum, account) => sum + account.equityUsd - account.dailyStartEquityUsd, 0),
    livePortfolio,
    livePortfolioComplete: LIVE_PILOT_INTEGRATION_IDS.every((chainId) => livePortfolio.some((account) => account.integrationId === chainId)),
  };
}

function scopeDashboardSnapshot(snapshot: DashboardSnapshot, view: DashboardViewId): DashboardSnapshot {
  const include = (...views: DashboardViewId[]) => views.includes(view);
  return {
    ...snapshot,
    wallets: include("overview", "wallets", "discovery", "trades") ? snapshot.wallets : [],
    positions: include("overview", "trades") ? snapshot.positions : [],
    positionLots: include("overview", "trades") ? snapshot.positionLots : [],
    trades: view === "trades" ? snapshot.trades : [],
    events: view === "overview" ? snapshot.events : [],
    consensus: view === "consensus" ? snapshot.consensus : [],
    aiAdvisories: view === "consensus" ? snapshot.aiAdvisories : [],
    serviceHealth: include("system", "rpc") ? snapshot.serviceHealth : [],
    rpcEndpoints: view === "rpc" ? snapshot.rpcEndpoints : [],
    hypercorePositions: include("overview", "trades") ? snapshot.hypercorePositions : [],
    hypercoreTrades: view === "trades" ? snapshot.hypercoreTrades : [],
    executionLots: include("overview", "my-wallets", "wallets", "trades") ? snapshot.executionLots : [],
    executionAttempts: view === "trades" ? snapshot.executionAttempts.slice(0, 100) : [],
    shadowPortfolio: include("overview", "my-wallets", "wallets") ? snapshot.shadowPortfolio : [],
    livePortfolio: include("overview", "my-wallets", "wallets") ? snapshot.livePortfolio : [],
    reconciliation: view === "system" ? snapshot.reconciliation : [],
    certificationSteps: view === "system" ? snapshot.certificationSteps : [],
  };
}

function enrichPositionsWithSources(
  positions: DashboardSnapshot["positions"],
  lots: DashboardSnapshot["positionLots"],
): DashboardSnapshot["positions"] {
  const grouped = new Map<string, DashboardSnapshot["positionLots"]>();
  for (const lot of lots) {
    const key = `${lot.chainId}:${lot.tokenAddress.toLowerCase()}`;
    grouped.set(key, [...(grouped.get(key) ?? []), lot]);
  }
  return positions.map((position) => {
    const openLots = grouped.get(`${position.chainId}:${position.tokenAddress.toLowerCase()}`) ?? [];
    const labels = [...new Set(openLots.map((lot) => lot.walletLabel).filter((label): label is string => Boolean(label)))];
    const openedAt = openLots.reduce<string | null>(
      (earliest, lot) => !earliest || lot.openedAt < earliest ? lot.openedAt : earliest,
      null,
    );
    return {
      ...position,
      sourceWalletLabels: labels.length ? labels : position.sourceWalletLabel ? [position.sourceWalletLabel] : [],
      openedAt,
    };
  });
}
