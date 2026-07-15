import type { ChainRuntime, RiskSettings } from "@/lib/domain/types";

export const DEFAULT_STARTING_BALANCE_USD = Number(
  process.env.PAPER_STARTING_BALANCE_USD ?? 100,
);

export const DEFAULT_RISK_SETTINGS: RiskSettings = {
  minPositionPercent: 5,
  maxPositionPercent: 10,
  dailyLossLimitPercent: 8,
  maxOpenPositions: 6,
  maxTokenExposurePercent: 15,
  maxWalletExposurePercent: 25,
  minimumLiquidityUsd: 50_000,
  maxSlippagePercent: 2,
  maxPriceImpactPercent: 2.5,
  cashReservePercent: 20,
  maxConsecutiveFailures: 3,
  maxRpcLatencyMs: 2_500,
  maxPriceChange24hPercent: 80,
  maxWalletSwapsPerHour: 8,
  maxWalletSwapsPer24Hours: 25,
};

export const CHAIN_DEFINITIONS: Record<"ethereum" | "base", Omit<ChainRuntime, "status" | "rpcConfigured" | "lastBlock" | "latencyMs" | "errorMessage" | "updatedAt"> & { rpcUrl: string }> = {
  ethereum: {
    id: "ethereum",
    name: "Ethereum",
    nativeSymbol: "ETH",
    rpcUrl: process.env.ETHEREUM_RPC_URL ?? "https://ethereum-rpc.publicnode.com",
  },
  base: {
    id: "base",
    name: "Base",
    nativeSymbol: "ETH",
    rpcUrl: process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
  },
};
