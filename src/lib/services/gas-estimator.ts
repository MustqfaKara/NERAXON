import { formatUnits } from "viem";
import { getPublicClient } from "@/lib/chains/public-client";
import type { ChainId } from "@/lib/domain/types";
import { calculateGasFeeUsd } from "@/lib/services/gas-calculation";
import { getMarketDataProvider } from "@/lib/services/market-data-provider";

const WRAPPED_ETH: Record<ChainId, string> = {
  ethereum: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  base: "0x4200000000000000000000000000000000000006",
};

const MODELED_SWAP_GAS: Record<ChainId, bigint> = {
  ethereum: 180_000n,
  base: 300_000n,
};

export interface GasEstimate {
  gasPriceGwei: number;
  gasUnits: number;
  nativePriceUsd: number;
  feeUsd: number;
}

export async function estimatePaperGas(chainId: ChainId): Promise<GasEstimate> {
  const [gasPrice, nativeMarket] = await Promise.all([
    getPublicClient(chainId).getGasPrice(),
    getMarketDataProvider().getTokenMarket(chainId, WRAPPED_ETH[chainId]),
  ]);
  const gasUnits = MODELED_SWAP_GAS[chainId];
  const feeUsd = calculateGasFeeUsd(chainId, gasPrice, gasUnits, nativeMarket.priceUsd);
  return {
    gasPriceGwei: Number(formatUnits(gasPrice, 9)),
    gasUnits: Number(gasUnits),
    nativePriceUsd: nativeMarket.priceUsd,
    feeUsd,
  };
}
