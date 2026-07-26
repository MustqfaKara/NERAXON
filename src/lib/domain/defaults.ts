import type { ChainId, ChainRuntime, EvmChainId, RiskSettings } from "@/lib/domain/types";
import { INTEGRATION_CATALOG, INTEGRATION_IDS } from "@/lib/domain/integrations";
import { readCredentialSync } from "../security/credential-vault.ts";

export const DEFAULT_STARTING_BALANCE_USD = Number(
  process.env.PAPER_STARTING_BALANCE_USD ?? 100,
);

export const DEFAULT_RISK_SETTINGS: RiskSettings = {
  minPositionPercent: 8,
  maxPositionPercent: 15,
  dailyLossLimitPercent: 10,
  maxOpenPositions: 12,
  maxTokenExposurePercent: 20,
  maxWalletExposurePercent: 30,
  minimumLiquidityUsd: 50_000,
  maxSlippagePercent: 3,
  maxPriceImpactPercent: 3,
  cashReservePercent: 15,
  maxConsecutiveFailures: 3,
  maxRpcLatencyMs: 2_500,
  maxPriceChange24hPercent: 80,
  maxWalletSwapsPerHour: 8,
  maxWalletSwapsPer24Hours: 50,
  maxHypercoreLeverage: 2,
  maxLiveTradeUsd: 25,
  maxLiveGasUsd: 5,
  networkFeeLimits: {
    ethereum: { maxFeeUsd: 1, maxFeePercent: 10 },
    base: { maxFeeUsd: 0.2, maxFeePercent: 5 },
    robinhood: { maxFeeUsd: 0.2, maxFeePercent: 8 },
    solana: { maxFeeUsd: 0.2, maxFeePercent: 8 },
    hyperliquid: { maxFeeUsd: 0.05, maxFeePercent: 2 },
  },
  networkExecutionLimits: {
    ethereum: { minPositionPercent: 8, maxPositionPercent: 15, minTradeUsd: 0, maxTradeUsd: 5, dailyLossLimitPercent: 10, cashReservePercent: 15, maxOpenPositions: 4, maxSlippagePercent: 2, maxLeverage: 1, maxQuoteAgeMs: 8_000, maxBuyPriceDeviationPercent: 3, maxSellPriceDeviationPercent: 6, maxEmergencyExitDeviationPercent: 12 },
    base: { minPositionPercent: 8, maxPositionPercent: 15, minTradeUsd: 0, maxTradeUsd: 5, dailyLossLimitPercent: 10, cashReservePercent: 15, maxOpenPositions: 4, maxSlippagePercent: 2, maxLeverage: 1, maxQuoteAgeMs: 8_000, maxBuyPriceDeviationPercent: 3, maxSellPriceDeviationPercent: 6, maxEmergencyExitDeviationPercent: 12 },
    robinhood: { minPositionPercent: 8, maxPositionPercent: 15, minTradeUsd: 0, maxTradeUsd: 5, dailyLossLimitPercent: 10, cashReservePercent: 15, maxOpenPositions: 4, maxSlippagePercent: 2, maxLeverage: 1, maxQuoteAgeMs: 8_000, maxBuyPriceDeviationPercent: 3, maxSellPriceDeviationPercent: 6, maxEmergencyExitDeviationPercent: 12 },
    solana: { minPositionPercent: 8, maxPositionPercent: 15, minTradeUsd: 0, maxTradeUsd: 5, dailyLossLimitPercent: 10, cashReservePercent: 15, maxOpenPositions: 4, maxSlippagePercent: 3, maxLeverage: 1, maxQuoteAgeMs: 5_000, maxBuyPriceDeviationPercent: 5, maxSellPriceDeviationPercent: 8, maxEmergencyExitDeviationPercent: 12 },
    hyperliquid: { minPositionPercent: 8, maxPositionPercent: 15, minTradeUsd: 10.5, maxTradeUsd: 12, dailyLossLimitPercent: 10, cashReservePercent: 15, maxOpenPositions: 2, maxSlippagePercent: 1.5, maxLeverage: 2, maxQuoteAgeMs: 3_000, maxBuyPriceDeviationPercent: 2, maxSellPriceDeviationPercent: 5, maxEmergencyExitDeviationPercent: 12 },
  },
  assetPolicy: {
    minimumSafetyScore: 55,
    youngPoolAgeMinutes: 30,
    youngPoolMinWallets: 3,
    youngPoolAllocationMultiplier: 0.5,
    requireVerifiedExitRoute: true,
    hypercoreMinVolume24hUsd: 100_000,
    hypercoreMinOpenInterestUsd: 100_000,
    trustedAssets: { ethereum: [], base: [], robinhood: [], solana: [], hyperliquid: [] },
    deniedAssets: { ethereum: [], base: [], robinhood: [], solana: [], hyperliquid: [] },
  },
};

export interface IntegrationDefinition extends Omit<ChainRuntime, "status" | "rpcConfigured" | "lastBlock" | "latencyMs" | "errorMessage" | "updatedAt"> {
  rpcUrl: string;
  explorerUrl: string;
  dexScreenerSlug: string | null;
}

export const CHAIN_DEFINITIONS: Record<ChainId, IntegrationDefinition> = {
  ethereum: {
    ...INTEGRATION_CATALOG.ethereum,
    rpcUrl: readCredentialSync("ethereum-rpc-url") ?? "https://ethereum-rpc.publicnode.com",
    explorerUrl: "https://etherscan.io",
    dexScreenerSlug: "ethereum",
  },
  base: {
    ...INTEGRATION_CATALOG.base,
    rpcUrl: readCredentialSync("base-rpc-url") ?? "https://mainnet.base.org",
    explorerUrl: "https://basescan.org",
    dexScreenerSlug: "base",
  },
  robinhood: {
    ...INTEGRATION_CATALOG.robinhood,
    rpcUrl: readCredentialSync("robinhood-rpc-url") ?? "https://rpc.mainnet.chain.robinhood.com",
    explorerUrl: "https://robinhoodchain.blockscout.com",
    dexScreenerSlug: "robinhood",
  },
  solana: {
    ...INTEGRATION_CATALOG.solana,
    rpcUrl: readCredentialSync("solana-rpc-url") ?? "https://api.mainnet-beta.solana.com",
    explorerUrl: "https://solscan.io",
    dexScreenerSlug: "solana",
  },
  hyperliquid: {
    ...INTEGRATION_CATALOG.hyperliquid,
    rpcUrl: readCredentialSync("hyperliquid-info-url") ?? "https://api.hyperliquid.xyz/info",
    explorerUrl: "https://app.hyperliquid.xyz/explorer",
    dexScreenerSlug: null,
  },
};

export { INTEGRATION_IDS };
export const EVM_CHAIN_IDS = INTEGRATION_IDS.filter((id): id is EvmChainId => CHAIN_DEFINITIONS[id].kind === "evm");
export const isEvmChain = (id: ChainId): id is EvmChainId => CHAIN_DEFINITIONS[id].kind === "evm";
