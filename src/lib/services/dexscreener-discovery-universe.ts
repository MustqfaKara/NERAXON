import { monitorService } from "@/lib/services/service-health";

export interface DexDiscoveryPair {
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
}

const DISCOVERY_FEEDS = [
  "token-profiles/latest/v1",
  "token-boosts/latest/v1",
  "token-boosts/top/v1",
  "community-takeovers/latest/v1",
] as const;

export async function getDexScreenerPromotedPairs(chainId: string): Promise<DexDiscoveryPair[]> {
  const feeds = await Promise.all(DISCOVERY_FEEDS.map(async (path) => {
    try {
      const response = await monitorService("dexscreener", () => fetch(
        `https://api.dexscreener.com/${path}`,
        { signal: AbortSignal.timeout(12_000), headers: { accept: "application/json" }, cache: "no-store" },
      ));
      if (!response.ok) return [];
      return await response.json() as Array<{ chainId?: string; tokenAddress?: string }>;
    } catch {
      return [];
    }
  }));
  const addresses = [...new Set(feeds.flat()
    .filter((item) => item.chainId === chainId && /^0x[0-9a-f]{40}$/i.test(item.tokenAddress ?? ""))
    .map((item) => item.tokenAddress!.toLowerCase()))]
    .slice(0, 30);
  if (!addresses.length) return [];
  const response = await monitorService("dexscreener", () => fetch(
    `https://api.dexscreener.com/tokens/v1/${chainId}/${addresses.join(",")}`,
    { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" }, cache: "no-store" },
  ));
  if (!response.ok) return [];
  return await response.json() as DexDiscoveryPair[];
}
