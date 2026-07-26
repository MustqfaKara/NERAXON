import type { ChainId } from "@/lib/domain/types";
import { SOLANA_NATIVE_MINT, SOLANA_STABLE_MINTS } from "../solana/constants.ts";

const QUOTE_TOKENS: Record<ChainId, Set<string>> = {
  ethereum: new Set([
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "0xdac17f958d2ee523a2206206994597c13d831ec7",
    "0x6b175474e89094c44da98b954eedeac495271d0f",
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  ]),
  base: new Set([
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca",
    "0x4200000000000000000000000000000000000006",
    "0x50c5725949a6f0c72e6c4a641f24049a917db0cb",
  ]),
  robinhood: new Set([
    "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
    "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  ]),
  solana: new Set([SOLANA_NATIVE_MINT, ...SOLANA_STABLE_MINTS]),
  hyperliquid: new Set(),
};

export function isQuoteToken(chainId: ChainId, tokenAddress: string) {
  return QUOTE_TOKENS[chainId].has(chainId === "solana" ? tokenAddress : tokenAddress.toLowerCase());
}

const WRAPPED_NATIVE: Record<ChainId, string> = {
  ethereum: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  base: "0x4200000000000000000000000000000000000006",
  robinhood: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
  solana: SOLANA_NATIVE_MINT,
  hyperliquid: "",
};

export function getQuoteTokenKind(chainId: ChainId, tokenAddress: string) {
  const normalized = chainId === "solana" ? tokenAddress : tokenAddress.toLowerCase();
  if (!isQuoteToken(chainId, normalized)) return null;
  return normalized === WRAPPED_NATIVE[chainId] ? "wrapped-native" as const : "stable" as const;
}

export function getWrappedNativeAddress(chainId: ChainId) {
  return WRAPPED_NATIVE[chainId];
}

export function getQuoteTokenDecimals(chainId: ChainId, tokenAddress: string) {
  const normalized = chainId === "solana" ? tokenAddress : tokenAddress.toLowerCase();
  if (chainId === "solana") return normalized === SOLANA_NATIVE_MINT ? 9 : 6;
  if (normalized === WRAPPED_NATIVE[chainId]) return 18;
  if (chainId === "ethereum") {
    if (normalized === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48") return 6;
    if (normalized === "0xdac17f958d2ee523a2206206994597c13d831ec7") return 6;
    return 18;
  }
  if (chainId === "robinhood" && normalized === "0x5fc5360d0400a0fd4f2af552add042d716f1d168") return 6;
  if (normalized === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913") return 6;
  if (normalized === "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca") return 6;
  return 18;
}
