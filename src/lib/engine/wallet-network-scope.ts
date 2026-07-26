import { INTEGRATION_IDS } from "../domain/integrations.ts";
import type { ChainId } from "../domain/types.ts";

const supportedChainIds = new Set<string>(INTEGRATION_IDS);

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
