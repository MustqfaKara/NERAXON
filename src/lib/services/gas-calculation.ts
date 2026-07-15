import { formatUnits } from "viem";

export type GasChainId = "ethereum" | "base";

export function calculateGasFeeUsd(
  chainId: GasChainId,
  gasPriceWei: bigint,
  gasUnits: bigint,
  nativePriceUsd: number,
) {
  const nativeCost = Number(formatUnits(gasPriceWei * gasUnits, 18));
  const baseL1BufferUsd = chainId === "base" ? 0.01 : 0;
  return nativeCost * nativePriceUsd + baseL1BufferUsd;
}
