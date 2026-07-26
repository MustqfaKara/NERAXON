import { getQuoteTokenKind } from "../chains/token-config.ts";
import type { ChainId } from "../domain/types.ts";

const stablecoinSymbols = new Set([
  "USDC",
  "USDC.E",
  "USDT",
  "USDT0",
  "DAI",
  "USDS",
  "USDE",
  "FDUSD",
  "TUSD",
  "PYUSD",
  "FRAX",
  "LUSD",
  "GHO",
  "USD0",
  "USDG",
]);

export function isStablecoinSymbol(symbol: string): boolean {
  return stablecoinSymbols.has(symbol.trim().toUpperCase());
}

export function isStablecoinAsset(chainId: ChainId, tokenAddress: string, tokenSymbol: string): boolean {
  return getQuoteTokenKind(chainId, tokenAddress) === "stable" || isStablecoinSymbol(tokenSymbol);
}

export function areOnlyStablecoinMovements(
  chainId: ChainId,
  movements: Array<{ tokenAddress: string; tokenSymbol: string }>,
): boolean {
  return movements.length > 0 && movements.every((movement) =>
    isStablecoinAsset(chainId, movement.tokenAddress, movement.tokenSymbol)
  );
}
