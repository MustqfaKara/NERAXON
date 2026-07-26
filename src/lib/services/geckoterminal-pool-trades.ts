import type { EvmChainId, DiscoveryGainerToken } from "@/lib/domain/types";
import { monitorService } from "@/lib/services/service-health";

export interface IndexedPoolTransfer {
  hash: string;
  from: string;
  to: string;
  tokenAddress: string;
  value: number;
  timestamp: string;
}

interface GeckoTrade {
  attributes?: {
    tx_hash?: string;
    tx_from_address?: string;
    from_token_amount?: string;
    to_token_amount?: string;
    from_token_address?: string;
    to_token_address?: string;
    block_timestamp?: string;
  };
}

export async function scanGeckoPoolTrades(
  chainId: EvmChainId,
  markets: DiscoveryGainerToken[],
): Promise<IndexedPoolTransfer[]> {
  const network = chainId === "base" ? "base" : chainId === "robinhood" ? "robinhood" : null;
  if (!network) return [];
  const results: IndexedPoolTransfer[] = [];
  for (let index = 0; index < markets.length; index += 2) {
    const chunk = markets.slice(index, index + 2);
    const pages = await Promise.all(chunk.map(async (market) => {
      try {
        const response = await monitorService("geckoterminal", () => fetch(
          `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${market.pairAddress}/trades`,
          { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" }, cache: "no-store" },
        ));
        if (!response.ok) return [];
        const payload = await response.json() as { data?: GeckoTrade[] };
        return toTransfers(market, payload.data ?? []);
      } catch {
        return [];
      }
    }));
    results.push(...pages.flat());
  }
  return results;
}

function toTransfers(market: DiscoveryGainerToken, trades: GeckoTrade[]) {
  const tokenAddress = market.address.toLowerCase();
  const poolAddress = market.pairAddress.toLowerCase();
  const cutoff = Date.now() - 86_400_000;
  return trades.flatMap((trade): IndexedPoolTransfer[] => {
    const attributes = trade.attributes;
    const wallet = attributes?.tx_from_address?.toLowerCase();
    const hash = attributes?.tx_hash?.toLowerCase();
    const timestamp = attributes?.block_timestamp;
    if (!wallet || !hash || !timestamp || Date.parse(timestamp) < cutoff) return [];
    const fromToken = attributes.from_token_address?.toLowerCase();
    const toToken = attributes.to_token_address?.toLowerCase();
    if (fromToken === tokenAddress) {
      const value = Number(attributes.from_token_amount ?? 0);
      return Number.isFinite(value) && value > 0 ? [{ hash, from: wallet, to: poolAddress, tokenAddress, value, timestamp }] : [];
    }
    if (toToken === tokenAddress) {
      const value = Number(attributes.to_token_amount ?? 0);
      return Number.isFinite(value) && value > 0 ? [{ hash, from: poolAddress, to: wallet, tokenAddress, value, timestamp }] : [];
    }
    return [];
  });
}
