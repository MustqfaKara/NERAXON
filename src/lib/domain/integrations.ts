import type { ChainId, IntegrationKind } from "@/lib/domain/types";

export interface IntegrationMetadata {
  id: ChainId;
  name: string;
  shortName: string;
  nativeSymbol: string;
  kind: IntegrationKind;
  explorerUrl: string;
  dexScreenerSlug: string | null;
}

export const INTEGRATION_CATALOG: Record<ChainId, IntegrationMetadata> = {
  ethereum: { id: "ethereum", name: "Ethereum", shortName: "ETH", nativeSymbol: "ETH", kind: "evm", explorerUrl: "https://etherscan.io", dexScreenerSlug: "ethereum" },
  base: { id: "base", name: "Base", shortName: "Base", nativeSymbol: "ETH", kind: "evm", explorerUrl: "https://basescan.org", dexScreenerSlug: "base" },
  robinhood: { id: "robinhood", name: "Robinhood", shortName: "RHC", nativeSymbol: "ETH", kind: "evm", explorerUrl: "https://robinhoodchain.blockscout.com", dexScreenerSlug: "robinhood" },
  solana: { id: "solana", name: "Solana", shortName: "SOL", nativeSymbol: "SOL", kind: "solana", explorerUrl: "https://solscan.io", dexScreenerSlug: "solana" },
  hyperliquid: { id: "hyperliquid", name: "Hyperliquid", shortName: "HL", nativeSymbol: "USDC", kind: "venue", explorerUrl: "https://app.hyperliquid.xyz/explorer", dexScreenerSlug: null },
};

export const INTEGRATION_IDS = Object.keys(INTEGRATION_CATALOG) as ChainId[];
export const SHADOW_TEST_INTEGRATION_IDS = ["base", "solana", "hyperliquid"] as const satisfies readonly ChainId[];
export const LIVE_PILOT_INTEGRATION_IDS = ["base", "robinhood", "solana", "hyperliquid"] as const satisfies readonly ChainId[];
export const SHADOW_TEST_BALANCE_USD = 33.33;
export const isShadowTestIntegration = (id: ChainId) => SHADOW_TEST_INTEGRATION_IDS.some((testId) => testId === id);
export const isLivePilotIntegration = (id: ChainId) => LIVE_PILOT_INTEGRATION_IDS.some((pilotId) => pilotId === id);
export const integrationName = (id: ChainId) => INTEGRATION_CATALOG[id].name;
export const integrationExplorerUrl = (id: ChainId, value: string, kind: "tx" | "address" = "tx") => {
  if (id === "hyperliquid") return `https://app.hyperliquid.xyz/explorer/address/${value}`;
  if (id === "solana") return `https://solscan.io/${kind === "tx" ? "tx" : "account"}/${value}`;
  return `${INTEGRATION_CATALOG[id].explorerUrl}/${kind}/${value}`;
};
export const integrationMarketUrl = (id: ChainId, pairOrCoin: string) => id === "hyperliquid"
  ? `https://app.hyperliquid.xyz/trade/${encodeURIComponent(pairOrCoin)}`
  : `https://dexscreener.com/${INTEGRATION_CATALOG[id].dexScreenerSlug}/${pairOrCoin}`;
