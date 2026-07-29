import { INTEGRATION_IDS } from "../domain/integrations.ts";
import type { ChainId } from "../domain/types.ts";

const supportedChainIds = new Set<string>(INTEGRATION_IDS);
const evmAddressPattern = /^0x[a-fA-F0-9]{40}$/;

interface WalletNetworkScope {
  address: string;
  isFavorite: boolean;
  trackedChainIds: readonly ChainId[];
}

export function parseTrackedChainIds(value: unknown): ChainId[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((chainId): chainId is ChainId => typeof chainId === "string" && supportedChainIds.has(chainId)))];
  } catch {
    return [];
  }
}

export function walletTracksChain(trackedChainIds: readonly ChainId[], chainId: ChainId): boolean {
  return trackedChainIds.includes(chainId);
}

export function favoriteWalletChainIds(address: string): ChainId[] {
  return evmAddressPattern.test(address.trim())
    ? INTEGRATION_IDS.filter((chainId) => chainId !== "solana")
    : ["solana"];
}

export function effectiveWalletChainIds(wallet: WalletNetworkScope): ChainId[] {
  return wallet.isFavorite
    ? favoriteWalletChainIds(wallet.address)
    : [...wallet.trackedChainIds];
}

export function walletTracksEffectiveChain(
  wallet: WalletNetworkScope,
  chainId: ChainId,
): boolean {
  return effectiveWalletChainIds(wallet).includes(chainId);
}
