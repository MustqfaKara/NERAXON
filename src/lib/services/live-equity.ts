import { erc20Abi, formatEther, formatUnits, type Address } from "viem";
import type { ChainId, EvmChainId, ShadowPortfolioSummary } from "@/lib/domain/types";
import { getPublicClient } from "@/lib/chains/public-client";
import { store } from "@/lib/repositories/store";
import { estimatePaperGas } from "@/lib/services/gas-estimator";
import { getMarketDataProvider } from "@/lib/services/market-data-provider";
import { getAllHypercoreClearinghouseStates, getHypercoreMarkets, hypercoreInfo } from "@/lib/services/hypercore-api";
import { solanaRpc } from "@/lib/solana/helius-client";
import { SOLANA_LAMPORTS_PER_SOL, SOLANA_NATIVE_MINT, SOLANA_TOKEN_2022_PROGRAM_ID, SOLANA_TOKEN_PROGRAM_ID } from "@/lib/solana/constants";
import { getExecutionAccount } from "@/lib/services/execution-account-service";
import { getNetworkExecutionLimit } from "@/lib/execution/network-execution-risk";
import { calculateLiveAccountPnl, calculatePortfolioEquity, executionLotValueUsd, remainingExecutionCost, resolveExposureLimitUsd } from "@/lib/engine/execution-accounting-math";
import { calculateHypercoreAccountValues } from "@/lib/engine/hypercore-live-accounting";
import { LIVE_PILOT_INTEGRATION_IDS } from "@/lib/domain/integrations";
import { resolveLivePositionLimit } from "@/lib/engine/live-position-capacity";
import { executionLotNetPnl } from "@/lib/engine/execution-wallet-performance";

interface ClearinghouseState {
  withdrawable?: string;
  marginSummary?: { accountValue?: string };
  assetPositions?: Array<{
    position?: {
      coin?: string;
      unrealizedPnl?: string;
      marginUsed?: string;
    };
  }>;
}
interface SpotState {
  balances?: Array<{ coin?: string; total?: string; hold?: string }>;
  tokenToAvailableAfterMaintenance?: Array<[number, string]>;
}

export async function getLivePortfolio(): Promise<ShadowPortfolioSummary[]> {
  return Promise.all(LIVE_PILOT_INTEGRATION_IDS.map((chainId) => getLiveNetworkPortfolio(chainId)));
}

export async function getLivePortfolioBestEffort(): Promise<ShadowPortfolioSummary[]> {
  const results = await Promise.allSettled(
    LIVE_PILOT_INTEGRATION_IDS.map((chainId) => getLiveNetworkPortfolio(chainId)),
  );
  return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
}

async function getLiveNetworkPortfolio(chainId: ChainId): Promise<ShadowPortfolioSummary> {
  const details = chainId === "hyperliquid"
    ? await hypercorePortfolioDetails()
    : chainId === "solana"
      ? await solanaPortfolioDetails()
      : await evmPortfolioDetails(chainId);
  const lots = store.listExecutionLots("live", chainId);
  const openLots = lots.filter((lot) => lot.status === "open");
  const positionUnrealizedPnlUsd = openLots.reduce(
    (sum, lot) => sum + executionLotValueUsd(lot) - remainingExecutionCost(lot),
    0,
  );
  const executionRealizedPnlUsd = lots.reduce((sum, lot) => sum + executionLotNetPnl(lot), 0);
  const confirmedAttempts = store.listExecutionAttempts(10_000)
    .filter((attempt) => attempt.mode === "live" && attempt.integrationId === chainId && attempt.status === "confirmed");
  const networkCostsUsd = confirmedAttempts.reduce((sum, attempt) => sum + attempt.networkFeeUsd, 0);
  const dexCostsUsd = confirmedAttempts.reduce((sum, attempt) => sum + attempt.dexFeeUsd, 0);
  const totalCostsUsd = networkCostsUsd + dexCostsUsd;
  const today = new Date().toISOString().slice(0, 10);
  const dailyStartEquityUsd = store.getOrCreateLiveDailyBaseline(chainId, today, details.equityUsd);
  const startingEquityUsd = store.getLiveInitialBaseline(chainId, dailyStartEquityUsd);
  const pnl = calculateLiveAccountPnl({
    equityUsd: details.equityUsd,
    initialEquityUsd: startingEquityUsd,
    dailyStartEquityUsd,
    executionRealizedPnlUsd,
    unrealizedPnlUsd: positionUnrealizedPnlUsd,
  });
  return {
    integrationId: chainId,
    startingEquityUsd,
    cashBalanceUsd: details.cashBalanceUsd,
    fundingTokenSymbol: details.fundingTokenSymbol,
    fundingTokenAmount: details.fundingTokenAmount,
    fundingTokenPriceUsd: details.fundingTokenPriceUsd,
    realizedPnlUsd: pnl.realizedPnlUsd,
    executionRealizedPnlUsd,
    totalCostsUsd,
    reservedBalanceUsd: details.reservedBalanceUsd,
    networkCostsUsd,
    dexCostsUsd,
    dailyStartEquityUsd,
    dailyStartDate: today,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    positionValueUsd: details.positionValueUsd,
    equityUsd: details.equityUsd,
    unrealizedPnlUsd: positionUnrealizedPnlUsd,
    positionUnrealizedPnlUsd,
    fundingTokenPnlUsd: pnl.accountDifferenceUsd,
    openPositionCount: new Set(openLots.map((lot) => `${lot.assetKey.toLowerCase()}:${lot.positionSide ?? "spot"}`)).size,
  };
}

async function evmPortfolioDetails(chainId: EvmChainId) {
  const snapshot = await getEvmAccountSnapshot(chainId);
  return {
    equityUsd: snapshot.equityUsd,
    cashBalanceUsd: snapshot.cashBalanceUsd,
    reservedBalanceUsd: 0,
    positionValueUsd: snapshot.positionValueUsd,
    fundingTokenSymbol: "ETH",
    fundingTokenAmount: snapshot.fundingTokenAmount,
    fundingTokenPriceUsd: snapshot.fundingTokenPriceUsd,
  };
}

async function solanaPortfolioDetails() {
  const snapshot = await getSolanaAccountSnapshot();
  return {
    equityUsd: snapshot.equityUsd,
    cashBalanceUsd: snapshot.cashBalanceUsd,
    reservedBalanceUsd: snapshot.reservedBalanceUsd,
    positionValueUsd: snapshot.positionValueUsd,
    fundingTokenSymbol: "SOL",
    fundingTokenAmount: snapshot.fundingTokenAmount,
    fundingTokenPriceUsd: snapshot.fundingTokenPriceUsd,
  };
}

async function hypercorePortfolioDetails() {
  const snapshot = await getHypercoreAccountSnapshot();
  return {
    ...snapshot,
    reservedBalanceUsd: 0,
    fundingTokenSymbol: "USDC",
    fundingTokenAmount: snapshot.cashBalanceUsd,
    fundingTokenPriceUsd: 1,
  };
}

async function getHypercoreAccountSnapshot() {
  const account = getExecutionAccount("hyperliquid");
  if (!account) throw new Error("Hyperliquid hesap adresi yapılandırılmadı.");
  const [perpStates, spot, abstraction, markets] = await Promise.all([
    getAllHypercoreClearinghouseStates<ClearinghouseState>(account),
    hypercoreInfo<SpotState>({ type: "spotClearinghouseState", user: account }),
    hypercoreInfo<string>({ type: "userAbstraction", user: account }),
    getHypercoreMarkets(),
  ]);
  const spotPricesUsd = Object.fromEntries(
    markets
      .filter((market) => market.marketType === "spot")
      .map((market) => [market.symbol, market.priceUsd]),
  );
  return calculateHypercoreAccountValues({
    unified: abstraction === "unifiedAccount",
    spotBalances: (spot.balances ?? []).map((balance) => ({
      coin: balance.coin ?? "",
      total: Number(balance.total ?? 0),
      hold: Number(balance.hold ?? 0),
    })),
    spotPricesUsd,
    availableUsdcAfterMaintenance: Number(
      spot.tokenToAvailableAfterMaintenance?.find(([token]) => token === 0)?.[1] ?? Number.NaN,
    ),
    perpStates: perpStates.map((state) => ({
      accountValueUsd: Number(state.marginSummary?.accountValue ?? 0),
      withdrawableUsd: Number(state.withdrawable ?? 0),
      unrealizedPnlUsd: (state.assetPositions ?? []).reduce(
        (sum, item) => sum + Number(item.position?.unrealizedPnl ?? 0),
        0,
      ),
    })),
  });
}

export async function assertLiveDailyLossLimit(chainId: ChainId, position?: {
  assetKey: string;
  walletId: string | null;
  side: "buy" | "sell";
  estimatedTradeUsd: number;
  minimumExecutableExposureUsd?: number;
}) {
  const equityUsd = await getExecutionEquityUsd(chainId);
  const date = new Date().toISOString().slice(0, 10);
  const baseline = store.getOrCreateLiveDailyBaseline(chainId, date, equityUsd);
  const lossPercent = baseline > 0 ? Math.max(0, (baseline - equityUsd) / baseline * 100) : 0;
  const limit = getNetworkExecutionLimit(chainId, store.getRiskSettings()).dailyLossLimitPercent;
  if (lossPercent >= limit) throw new Error(`${chainId} günlük canlı zarar oranı %${lossPercent.toFixed(2)} ile %${limit} sınırına ulaştı.`);
  if (store.getCircuitBreaker().halted) throw new Error("Devre kesici aktifken canlı emir gönderilemez.");
  if (position?.side === "buy") assertLivePositionRisk(chainId, equityUsd, position);
  return { equityUsd, baselineUsd: baseline, lossPercent };
}

function assertLivePositionRisk(chainId: ChainId, equityUsd: number, position: NonNullable<Parameters<typeof assertLiveDailyLossLimit>[1]>) {
  const settings = store.getRiskSettings();
  const networkLimit = getNetworkExecutionLimit(chainId, settings);
  const openLots = store.listExecutionLots("live", chainId).filter((lot) => lot.status === "open");
  const distinctPositions = new Set(openLots.map((lot) => `${lot.assetKey.toLowerCase()}:${lot.positionSide ?? "spot"}`));
  const assetExists = openLots.some((lot) => lot.assetKey.toLowerCase() === position.assetKey.toLowerCase());
  const effectivePositionLimit = resolveLivePositionLimit({
    equityUsd,
    estimatedTradeUsd: position.estimatedTradeUsd,
    configuredLimit: networkLimit.maxOpenPositions,
    globalLimit: settings.maxOpenPositions,
    cashReservePercent: networkLimit.cashReservePercent,
    minPositionPercent: networkLimit.minPositionPercent,
    minTradeUsd: networkLimit.minTradeUsd,
  });
  if (!assetExists && distinctPositions.size >= effectivePositionLimit) {
    throw new Error(`${chainId} canlı açık pozisyon sınırına ulaştı. Portföy kapasitesi: ${effectivePositionLimit}.`);
  }
  const tokenExposureUsd = openLots.filter((lot) => lot.assetKey.toLowerCase() === position.assetKey.toLowerCase()).reduce((sum, lot) => sum + remainingExecutionCost(lot), 0);
  const tokenExposureLimitUsd = resolveExposureLimitUsd(
    equityUsd,
    settings.maxTokenExposurePercent,
    networkLimit.minTradeUsd,
    position.minimumExecutableExposureUsd,
  );
  if (tokenExposureUsd + position.estimatedTradeUsd > tokenExposureLimitUsd) throw new Error(`${chainId} canlı token maruziyet sınırı aşılacak.`);
  if (position.walletId) {
    const walletExposureUsd = openLots.filter((lot) => lot.walletId === position.walletId).reduce((sum, lot) => sum + remainingExecutionCost(lot), 0);
    const walletExposureLimitUsd = resolveExposureLimitUsd(
      equityUsd,
      settings.maxWalletExposurePercent,
      networkLimit.minTradeUsd,
      position.minimumExecutableExposureUsd,
    );
    if (walletExposureUsd + position.estimatedTradeUsd > walletExposureLimitUsd) throw new Error(`${chainId} canlı kaynak cüzdan maruziyet sınırı aşılacak.`);
  }
  const reserveUsd = equityUsd * networkLimit.cashReservePercent / 100;
  if (position.estimatedTradeUsd > equityUsd - reserveUsd) throw new Error(`${chainId} canlı rezervi bu işlemden sonra korunamıyor.`);
}

export function getExecutionEquityUsd(chainId: ChainId) {
  return chainId === "hyperliquid" ? hypercoreEquityUsd() : chainId === "solana" ? solanaEquityUsd() : evmEquityUsd(chainId);
}

async function solanaEquityUsd() {
  return (await getSolanaAccountSnapshot()).equityUsd;
}

async function getSolanaAccountSnapshot() {
  const address = getExecutionAccount("solana");
  if (!address) throw new Error("Solana işlem hesabı yapılandırılmadı.");
  const [balance, nativeMarket, tokenAccountResponses] = await Promise.all([
    solanaRpc<{ value: number }>("getBalance", [address, { commitment: "confirmed" }]),
    getMarketDataProvider().getTokenMarket("solana", SOLANA_NATIVE_MINT),
    Promise.all([SOLANA_TOKEN_PROGRAM_ID, SOLANA_TOKEN_2022_PROGRAM_ID].map((programId) => (
      solanaRpc<{ value: Array<{ account?: { lamports?: number; data?: { parsed?: { info?: { mint?: string; tokenAmount?: { uiAmountString?: string } } } } } }> }>("getTokenAccountsByOwner", [address, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }])
    ))),
  ]);
  const tokenAccounts = tokenAccountResponses.flatMap((response) => response.value);
  const refundableRentLamports = tokenAccounts.reduce((sum, item) => sum + (item.account?.lamports ?? 0), 0);
  const amounts = new Map<string, number>();
  for (const item of tokenAccounts) {
    const info = item.account?.data?.parsed?.info;
    if (info?.mint) amounts.set(info.mint, (amounts.get(info.mint) ?? 0) + Number(info.tokenAmount?.uiAmountString ?? 0));
  }
  const tokens = [...new Set(store.listExecutionLots("live", "solana").filter((lot) => lot.status === "open" && lot.marketType === "solana").map((lot) => lot.assetKey))];
  const markets = await Promise.all(tokens.map((mint) => getMarketDataProvider().getTokenMarket("solana", mint)));
  const positionValueUsd = tokens.reduce((sum, mint, index) => sum + (amounts.get(mint) ?? 0) * markets[index].priceUsd, 0);
  const fundingTokenAmount = balance.value / SOLANA_LAMPORTS_PER_SOL;
  const cashBalanceUsd = fundingTokenAmount * nativeMarket.priceUsd;
  const reservedBalanceUsd = refundableRentLamports / SOLANA_LAMPORTS_PER_SOL * nativeMarket.priceUsd;
  return {
    fundingTokenAmount,
    fundingTokenPriceUsd: nativeMarket.priceUsd,
    cashBalanceUsd,
    reservedBalanceUsd,
    positionValueUsd,
    equityUsd: calculatePortfolioEquity(cashBalanceUsd, positionValueUsd, reservedBalanceUsd),
  };
}

async function evmEquityUsd(chainId: EvmChainId) {
  return (await getEvmAccountSnapshot(chainId)).equityUsd;
}

async function getEvmAccountSnapshot(chainId: EvmChainId) {
  const account = getExecutionAccount("evm");
  if (!account) throw new Error("EVM işlem hesabı yapılandırılmadı.");
  const address = account as Address;
  const client = getPublicClient(chainId);
  const [nativeBalance, gas] = await Promise.all([client.getBalance({ address }), estimatePaperGas(chainId)]);
  const fundingTokenAmount = Number(formatEther(nativeBalance));
  const cashBalanceUsd = fundingTokenAmount * gas.nativePriceUsd;
  let positionValueUsd = 0;
  const tokenAddresses = [...new Set(store.listExecutionLots("live", chainId).filter((lot) => lot.status === "open" && lot.marketType === "evm").map((lot) => lot.assetKey))];
  for (const tokenAddress of tokenAddresses) {
    const [balance, decimals, market] = await Promise.all([
      client.readContract({ address: tokenAddress as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
      client.readContract({ address: tokenAddress as `0x${string}`, abi: erc20Abi, functionName: "decimals" }),
      getMarketDataProvider().getTokenMarket(chainId, tokenAddress),
    ]);
    positionValueUsd += Number(formatUnits(balance, decimals)) * market.priceUsd;
  }
  return {
    fundingTokenAmount,
    fundingTokenPriceUsd: gas.nativePriceUsd,
    cashBalanceUsd,
    positionValueUsd,
    equityUsd: calculatePortfolioEquity(cashBalanceUsd, positionValueUsd, 0),
  };
}

async function hypercoreEquityUsd() {
  return (await getHypercoreAccountSnapshot()).equityUsd;
}
