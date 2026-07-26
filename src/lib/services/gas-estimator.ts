import { formatUnits } from "viem";
import { getPublicClient } from "@/lib/chains/public-client";
import type { ChainId, EvmChainId } from "@/lib/domain/types";
import { calculateGasFeeUsd } from "@/lib/services/gas-calculation";
import { getMarketDataProvider } from "@/lib/services/market-data-provider";
import { SOLANA_NATIVE_MINT } from "@/lib/solana/constants";

const WRAPPED_ETH: Record<EvmChainId, string> = {
  ethereum: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  base: "0x4200000000000000000000000000000000000006",
  robinhood: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
};

const MODELED_SWAP_GAS: Record<EvmChainId, bigint> = {
  ethereum: 180_000n,
  base: 300_000n,
  robinhood: 300_000n,
};

export interface GasEstimate {
  gasPriceGwei: number;
  gasUnits: number;
  nativePriceUsd: number;
  feeUsd: number;
}

export async function estimatePaperGas(chainId: ChainId): Promise<GasEstimate> {
  if (chainId === "hyperliquid") return { gasPriceGwei: 0, gasUnits: 0, nativePriceUsd: 1, feeUsd: 0 };
  if (chainId === "solana") {
    const nativePriceUsd = (await getMarketDataProvider().getTokenMarket("solana", SOLANA_NATIVE_MINT)).priceUsd;
    const feeSol = 0.000015;
    return { gasPriceGwei: 0, gasUnits: 1, nativePriceUsd, feeUsd: feeSol * nativePriceUsd };
  }
  const [gasPrice, nativeMarket] = await Promise.all([
    getPublicClient(chainId).getGasPrice(),
    getNativeMarketPrice(chainId),
  ]);
  const gasUnits = MODELED_SWAP_GAS[chainId];
  const feeUsd = calculateGasFeeUsd(chainId, gasPrice, gasUnits, nativeMarket);
  return {
    gasPriceGwei: Number(formatUnits(gasPrice, 9)),
    gasUnits: Number(gasUnits),
    nativePriceUsd: nativeMarket,
    feeUsd,
  };
}

async function getNativeMarketPrice(chainId: EvmChainId) {
  if (chainId !== "robinhood") {
    return (await getMarketDataProvider().getTokenMarket(chainId, WRAPPED_ETH[chainId])).priceUsd;
  }
  const wrappedNative = WRAPPED_ETH.robinhood;
  const response = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${wrappedNative}`, {
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Robinhood ETH fiyatı alınamadı (${response.status}).`);
  const payload = await response.json() as {
    pairs?: Array<{
      chainId?: string;
      priceNative?: string | null;
      priceUsd?: string | null;
      liquidity?: { usd?: number | null } | null;
      quoteToken?: { address?: string };
    }>;
  };
  const pair = (payload.pairs ?? [])
    .filter((item) => item.chainId === "robinhood" && item.quoteToken?.address?.toLowerCase() === wrappedNative)
    .filter((item) => Number(item.priceUsd) > 0 && Number(item.priceNative) > 0)
    .sort((left, right) => Number(right.liquidity?.usd ?? 0) - Number(left.liquidity?.usd ?? 0))[0];
  if (!pair) throw new Error("Robinhood ETH fiyatı için geçerli DexScreener havuzu bulunamadı.");
  return Number(pair.priceUsd) / Number(pair.priceNative);
}
