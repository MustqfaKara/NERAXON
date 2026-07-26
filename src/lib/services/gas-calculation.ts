import { formatUnits } from "viem";

export type GasChainId = "ethereum" | "base" | "robinhood";

export function calculateGasFeeUsd(
  chainId: GasChainId,
  gasPriceWei: bigint,
  gasUnits: bigint,
  nativePriceUsd: number,
) {
  const nativeCost = Number(formatUnits(gasPriceWei * gasUnits, 18));
  const baseL1BufferUsd = chainId === "base" ? Math.max(0.001, nativeCost * nativePriceUsd * 0.25) : 0;
  return nativeCost * nativePriceUsd + baseL1BufferUsd;
}
