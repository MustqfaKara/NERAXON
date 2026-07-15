import type { DashboardSnapshot } from "@/lib/domain/types";
import { store } from "@/lib/repositories/store";
import { getMarketDataProvider } from "@/lib/services/market-data-provider";
import { getChainAdapter } from "@/lib/chains/registry";
import { getConsensusEntries, getPerformanceAnalytics } from "@/lib/services/analytics-service";
import { listServiceHealth, monitorService } from "@/lib/services/service-health";

export async function refreshDashboardMarkets(): Promise<DashboardSnapshot> {
  await refreshChainHealth();
  const positions = store.listPositions();
  if (!positions.length) return getDashboardSnapshot();

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

  const updatedCount = results.reduce(
    (total, result) => total + (result.status === "fulfilled" ? result.value : 0),
    0,
  );
  if (updatedCount === 0) {
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    throw failure?.reason instanceof Error
      ? failure.reason
      : new Error("Açık pozisyonlar için güncel piyasa fiyatı bulunamadı.");
  }

  return getDashboardSnapshot();
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
  store.repairLegacyDiscoveryScores();
  const positions = store.listPositions();
  const trades = store.listTrades();
  const startingBalanceUsd = store.getStartingBalance();
  const cashBalanceUsd = store.getCashBalance();
  const positionValue = positions.reduce((sum, position) => sum + position.quantity * position.currentPriceUsd, 0);
  const unrealizedPnlUsd = positions.reduce((sum, position) => sum + position.unrealizedPnlUsd, 0);
  const equityUsd = cashBalanceUsd + positionValue;
  const totalFeesUsd = store.getTotalTradeFeesUsd();
  const realizedPnlUsd = equityUsd - startingBalanceUsd - unrealizedPnlUsd;
  const today = new Date().toISOString().slice(0, 10);
  if (store.getDailyStartDate() !== today) {
    store.setDailyStartDate(today);
    store.setDailyStartEquity(equityUsd);
  }
  const dailyPnlUsd = equityUsd - store.getDailyStartEquity();

  return {
    language: store.getLanguage(),
    mode: store.getMode(),
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
    positionLots: store.listPositionLots(),
    trades,
    events: store.listEvents(),
    riskSettings: store.getRiskSettings(),
    circuitBreaker: store.getCircuitBreaker(),
    analytics: getPerformanceAnalytics(),
    consensus: getConsensusEntries(),
    serviceHealth: listServiceHealth(),
  };
}
