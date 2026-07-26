import type { ChainId } from "../domain/types.ts";
import type { MarketSnapshot } from "../services/market-data-provider.ts";

export interface DexScreenerSocialPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string | null;
  priceNative?: string | null;
  liquidity?: { usd?: number | null } | null;
  volume?: { h24?: number | null } | null;
  priceChange?: { h24?: number | null } | null;
  marketCap?: number | null;
  fdv?: number | null;
  pairCreatedAt?: number | null;
  txns?: { h24?: { buys?: number; sells?: number } } | null;
}

export interface ResolvedSocialMarket extends Omit<MarketSnapshot, "chainId"> {
  chainId: ChainId | null;
  dexScreenerChainId: string;
}

const DEXSCREENER_CHAIN_MAP: Partial<Record<string, ChainId>> = {
  ethereum: "ethereum",
  base: "base",
  robinhood: "robinhood",
  solana: "solana",
};

export function pairToSocialMarket(pair: DexScreenerSocialPair, targetAddress?: string): ResolvedSocialMarket | null {
  const dexScreenerChainId = pair.chainId?.trim().toLowerCase();
  const pairAddress = pair.pairAddress?.trim();
  const baseAddress = pair.baseToken?.address?.trim();
  const quoteAddress = pair.quoteToken?.address?.trim();
  if (!dexScreenerChainId || !pairAddress || !baseAddress) return null;

  const normalizedTarget = targetAddress ? normalizeSocialAddress(dexScreenerChainId, targetAddress) : null;
  const targetIsBase = !normalizedTarget || normalizeSocialAddress(dexScreenerChainId, baseAddress) === normalizedTarget;
  const targetIsQuote = Boolean(
    normalizedTarget
    && quoteAddress
    && normalizeSocialAddress(dexScreenerChainId, quoteAddress) === normalizedTarget
  );
  if (!targetIsBase && !targetIsQuote) return null;

  const basePriceUsd = Number(pair.priceUsd);
  const priceNative = Number(pair.priceNative);
  const priceUsd = targetIsQuote ? basePriceUsd / priceNative : basePriceUsd;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  const rawPriceChange = Number(pair.priceChange?.h24 ?? 0);
  const quotePriceChange = rawPriceChange > -100
    ? ((1 / (1 + rawPriceChange / 100)) - 1) * 100
    : 0;

  return {
    chainId: DEXSCREENER_CHAIN_MAP[dexScreenerChainId] ?? null,
    dexScreenerChainId,
    tokenAddress: targetIsQuote ? quoteAddress! : baseAddress,
    tokenSymbol: targetIsQuote ? pair.quoteToken?.symbol ?? "TOKEN" : pair.baseToken?.symbol ?? "TOKEN",
    priceUsd,
    liquidityUsd: Number(pair.liquidity?.usd ?? 0),
    volume24hUsd: Number(pair.volume?.h24 ?? 0),
    priceChange24hPercent: targetIsQuote ? quotePriceChange : rawPriceChange,
    marketCapUsd: targetIsQuote || typeof pair.marketCap !== "number" ? null : pair.marketCap,
    fdvUsd: targetIsQuote || typeof pair.fdv !== "number" ? null : pair.fdv,
    pairAddress,
    dexId: pair.dexId ?? "unknown",
    pairCreatedAt: pair.pairCreatedAt ?? null,
    fetchedAt: new Date().toISOString(),
    buys24h: Number(pair.txns?.h24?.buys ?? 0),
    sells24h: Number(pair.txns?.h24?.sells ?? 0),
  };
}

function normalizeSocialAddress(dexScreenerChainId: string, address: string) {
  return dexScreenerChainId === "solana" ? address.trim() : address.trim().toLowerCase();
}
