import type { ChainId, ShadowPortfolioSummary } from "@/lib/domain/types";
import { store } from "@/lib/repositories/store";
import { getMarketDataProvider } from "@/lib/services/market-data-provider";
import { findHypercoreMarket, getHypercoreMarkets } from "@/lib/services/hypercore-api";
import {
  consumedExecutionCost,
  executionLotValueUsd,
  remainingExecutionCost,
  resolveExposureLimitUsd,
} from "@/lib/engine/execution-accounting-math";
import { isShadowTestIntegration, SHADOW_TEST_BALANCE_USD } from "@/lib/domain/integrations";
import { INTEGRATION_CATALOG } from "@/lib/domain/integrations";
import { estimatePaperGas } from "@/lib/services/gas-estimator";
import { getNetworkExecutionLimit } from "@/lib/execution/network-execution-risk";
import { calculateShadowPnl } from "@/lib/engine/shadow-pnl";

const SHADOW_RAMP_LIMIT_USD = 10;
const SHADOW_RAMP_DURATION_MS = 24 * 60 * 60_000;

export async function ensureShadowAccount(chainId: ChainId) {
  if (!isShadowTestIntegration(chainId)) throw new Error(`${chainId} ilk shadow test kapsamına dahil değil.`);
  const existing = store.getShadowAccount(chainId);
  if (existing?.fundingTokenAmount && existing.fundingTokenPriceUsd > 0) return existing;
  const fundingToken = await getFundingToken(chainId, existing?.cashBalanceUsd ?? SHADOW_TEST_BALANCE_USD);
  if (existing) {
    const updated = {
      ...existing,
      cashBalanceUsd: fundingToken.amount * fundingToken.priceUsd,
      fundingTokenSymbol: fundingToken.symbol,
      fundingTokenAmount: fundingToken.amount,
      fundingTokenPriceUsd: fundingToken.priceUsd,
    };
    store.updateShadowAccount(updated);
    return updated;
  }
  return store.ensureShadowAccount(chainId, SHADOW_TEST_BALANCE_USD, fundingToken);
}

export async function refreshExecutionMarkets(mode: "shadow" | "live") {
  const lots = store.listExecutionLots(mode).filter((lot) => lot.status === "open");
  const hypercoreLots = lots.filter((lot) => lot.integrationId === "hyperliquid");
  const tokenLots = lots.filter((lot) => lot.integrationId !== "hyperliquid");
  const tokenLotsByChain = new Map<ChainId, typeof tokenLots>();
  for (const lot of tokenLots) {
    const chainLots = tokenLotsByChain.get(lot.integrationId) ?? [];
    chainLots.push(lot);
    tokenLotsByChain.set(lot.integrationId, chainLots);
  }
  await Promise.allSettled([...tokenLotsByChain.entries()].map(async ([chainId, chainLots]) => {
    const markets = await getMarketDataProvider().getTokenMarkets(
      chainId,
      [...new Set(chainLots.map((lot) => lot.assetKey))],
      { forceRefresh: true },
    );
    const marketByAsset = new Map(markets.map((market) => [market.tokenAddress.toLowerCase(), market]));
    for (const lot of chainLots) {
      const market = marketByAsset.get(lot.assetKey.toLowerCase());
      if (market) store.updateExecutionLotMarket(lot.id, market.priceUsd);
    }
  }));

  if (hypercoreLots.length) {
    const markets = await getHypercoreMarkets(true);
    for (const lot of hypercoreLots) {
      const symbol = lot.assetKey.split(":").slice(1).join(":");
      const market = findHypercoreMarket(markets, lot.marketType === "perp" ? "perp" : "spot", symbol);
      if (market) store.updateExecutionLotMarket(lot.id, market.priceUsd);
    }
  }

  if (mode === "shadow") {
    await Promise.allSettled(store.listShadowAccounts().map(async (account) => {
      if (!isShadowTestIntegration(account.integrationId)) return;
      const estimate = await estimatePaperGas(account.integrationId);
      if (!Number.isFinite(estimate.nativePriceUsd) || estimate.nativePriceUsd <= 0) return;
      const initializedAmount = account.fundingTokenAmount > 0
        ? account.fundingTokenAmount
        : account.cashBalanceUsd / estimate.nativePriceUsd;
      store.updateShadowAccount({
        ...account,
        cashBalanceUsd: initializedAmount * estimate.nativePriceUsd,
        fundingTokenSymbol: INTEGRATION_CATALOG[account.integrationId].nativeSymbol,
        fundingTokenAmount: initializedAmount,
        fundingTokenPriceUsd: estimate.nativePriceUsd,
      });
    }));
  }
}

export function getShadowPortfolio(): ShadowPortfolioSummary[] {
  const lots = store.listExecutionLots("shadow").filter((lot) => lot.status === "open");
  const attempts = store.listExecutionAttempts(10_000).filter((attempt) => attempt.mode === "shadow" && attempt.status === "simulated");
  return store.listShadowAccounts().map((account) => {
    const owned = lots.filter((lot) => lot.integrationId === account.integrationId);
    const positionValueUsd = owned.reduce((total, lot) => total + executionLotValueUsd(lot), 0);
    const remainingCostUsd = owned.reduce((total, lot) => total + remainingExecutionCost(lot), 0);
    const equityUsd = account.cashBalanceUsd + positionValueUsd;
    const accountAttempts = attempts.filter((attempt) => attempt.integrationId === account.integrationId);
    const networkCostsUsd = accountAttempts.reduce((sum, attempt) => sum + attempt.networkFeeUsd, 0);
    const dexCostsUsd = accountAttempts.reduce((sum, attempt) => sum + attempt.dexFeeUsd, 0);
    const pnl = calculateShadowPnl({
      startingEquityUsd: account.startingEquityUsd,
      equityUsd,
      realizedPnlUsd: account.realizedPnlUsd,
      positionValueUsd,
      remainingPositionCostUsd: remainingCostUsd,
    });
    const today = new Date().toISOString().slice(0, 10);
    if (account.dailyStartDate !== today) {
      store.updateShadowAccount({ ...account, dailyStartDate: today, dailyStartEquityUsd: equityUsd });
      account.dailyStartDate = today;
      account.dailyStartEquityUsd = equityUsd;
    }
    return {
      ...account,
      positionValueUsd,
      equityUsd,
      reservedBalanceUsd: 0,
      networkCostsUsd,
      dexCostsUsd,
      ...pnl,
      openPositionCount: new Set(owned.map((lot) => `${lot.assetKey}:${lot.positionSide ?? ""}`)).size,
    };
  });
}

export async function assertShadowPortfolioRisk(input: {
  chainId: ChainId;
  assetKey: string;
  walletId: string | null;
  side: "buy" | "sell";
  estimatedTradeUsd: number;
  minimumExecutableExposureUsd?: number;
}) {
  const account = await ensureShadowAccount(input.chainId);
  const summary = getShadowPortfolio().find((item) => item.integrationId === input.chainId)!;
  const settings = store.getRiskSettings();
  const networkLimit = getNetworkExecutionLimit(input.chainId, settings);
  if (!Number.isFinite(input.estimatedTradeUsd) || input.estimatedTradeUsd <= 0) throw new Error("Shadow işlem değeri doğrulanamadı.");
  const ramping = Date.now() - new Date(account.createdAt).getTime() < SHADOW_RAMP_DURATION_MS;
  const maxTradeUsd = ramping ? Math.min(SHADOW_RAMP_LIMIT_USD, networkLimit.maxTradeUsd) : networkLimit.maxTradeUsd;
  if (input.side === "sell") return { account, summary, maxTradeUsd, ramping };
  if (input.estimatedTradeUsd > maxTradeUsd + 0.01) {
    throw new Error(`Shadow işlem ${input.estimatedTradeUsd.toFixed(2)} USD ile ${maxTradeUsd.toFixed(2)} USD tavanını aşıyor.`);
  }
  if (store.getCircuitBreaker().halted) throw new Error("Devre kesici aktifken yeni shadow pozisyonu açılamaz.");

  const openLots = store.listExecutionLots("shadow", input.chainId).filter((lot) => lot.status === "open");
  const distinctPositions = new Set(openLots.map((lot) => `${lot.assetKey}:${lot.positionSide ?? ""}`));
  const assetExists = openLots.some((lot) => lot.assetKey.toLowerCase() === input.assetKey.toLowerCase());
  if (!assetExists && distinctPositions.size >= networkLimit.maxOpenPositions) throw new Error("Shadow maksimum açık pozisyon sayısına ulaşıldı.");
  const reserveUsd = summary.equityUsd * networkLimit.cashReservePercent / 100;
  if (account.cashBalanceUsd - input.estimatedTradeUsd < reserveUsd) throw new Error("Shadow nakit rezervi bu işlemden sonra korunamıyor.");
  const tokenExposure = openLots.filter((lot) => lot.assetKey.toLowerCase() === input.assetKey.toLowerCase()).reduce((sum, lot) => sum + remainingExecutionCost(lot), 0);
  const tokenExposureLimitUsd = resolveExposureLimitUsd(
    summary.equityUsd,
    settings.maxTokenExposurePercent,
    networkLimit.minTradeUsd,
    input.minimumExecutableExposureUsd,
  );
  if (tokenExposure + input.estimatedTradeUsd > tokenExposureLimitUsd) {
    throw new Error("Shadow token maruziyet sınırı aşılacak.");
  }
  if (input.walletId) {
    const walletExposure = openLots.filter((lot) => lot.walletId === input.walletId).reduce((sum, lot) => sum + remainingExecutionCost(lot), 0);
    const walletExposureLimitUsd = resolveExposureLimitUsd(
      summary.equityUsd,
      settings.maxWalletExposurePercent,
      networkLimit.minTradeUsd,
      input.minimumExecutableExposureUsd,
    );
    if (walletExposure + input.estimatedTradeUsd > walletExposureLimitUsd) {
      throw new Error("Shadow cüzdan maruziyet sınırı aşılacak.");
    }
  }
  const dailyLossPercent = account.dailyStartEquityUsd > 0
    ? Math.max(0, (account.dailyStartEquityUsd - summary.equityUsd) / account.dailyStartEquityUsd * 100)
    : 0;
  if (dailyLossPercent >= networkLimit.dailyLossLimitPercent) throw new Error("Shadow günlük zarar sınırı aşıldı.");
  return { account, summary, maxTradeUsd, ramping };
}

export function applyShadowBuy(chainId: ChainId, entryCostUsd: number, costsUsd: number) {
  const account = store.getShadowAccount(chainId);
  if (!account) throw new Error("Shadow hesap başlatılmadı.");
  if (account.fundingTokenPriceUsd <= 0) throw new Error("Shadow harcama tokeni fiyatı hazır değil.");
  if (entryCostUsd > account.cashBalanceUsd + 0.01) throw new Error("Shadow kullanılabilir bakiye yetersiz.");
  const fundingTokenAmount = Math.max(0, account.fundingTokenAmount - entryCostUsd / account.fundingTokenPriceUsd);
  store.updateShadowAccount({
    ...account,
    cashBalanceUsd: fundingTokenAmount * account.fundingTokenPriceUsd,
    fundingTokenAmount,
    totalCostsUsd: account.totalCostsUsd + Math.max(0, costsUsd),
  });
}

export function applyShadowSell(chainId: ChainId, netProceedsUsd: number, realizedPnlUsd: number, costsUsd: number) {
  const account = store.getShadowAccount(chainId);
  if (!account) throw new Error("Shadow hesap başlatılmadı.");
  if (account.fundingTokenPriceUsd <= 0) throw new Error("Shadow harcama tokeni fiyatı hazır değil.");
  const fundingTokenAmount = account.fundingTokenAmount + Math.max(0, netProceedsUsd) / account.fundingTokenPriceUsd;
  store.updateShadowAccount({
    ...account,
    cashBalanceUsd: fundingTokenAmount * account.fundingTokenPriceUsd,
    fundingTokenAmount,
    realizedPnlUsd: account.realizedPnlUsd + realizedPnlUsd,
    totalCostsUsd: account.totalCostsUsd + Math.max(0, costsUsd),
  });
}

export const consumedCost = consumedExecutionCost;

async function getFundingToken(chainId: ChainId, valueUsd: number) {
  const estimate = await estimatePaperGas(chainId);
  if (!Number.isFinite(estimate.nativePriceUsd) || estimate.nativePriceUsd <= 0) {
    throw new Error(`${INTEGRATION_CATALOG[chainId].nativeSymbol} fiyatı alınamadı.`);
  }
  return {
    symbol: INTEGRATION_CATALOG[chainId].nativeSymbol,
    amount: valueUsd / estimate.nativePriceUsd,
    priceUsd: estimate.nativePriceUsd,
  };
}
