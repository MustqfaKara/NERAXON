export interface WalletActivityLimitInput {
  swapsLastHour: number;
  swapsLast24Hours: number;
  maxSwapsPerHour: number;
  maxSwapsPer24Hours: number;
}

export interface WalletActivityLimitDecision {
  exceeded: boolean;
  reason: string | null;
}

export function evaluateWalletActivityLimit(input: WalletActivityLimitInput): WalletActivityLimitDecision {
  if (input.swapsLastHour > input.maxSwapsPerHour) {
    return {
      exceeded: true,
      reason: `Son 1 saatte ${input.swapsLastHour} swap görüldü; saatlik sınır ${input.maxSwapsPerHour}.`,
    };
  }
  if (input.swapsLast24Hours > input.maxSwapsPer24Hours) {
    return {
      exceeded: true,
      reason: `Son 24 saatte ${input.swapsLast24Hours} swap görüldü; günlük sınır ${input.maxSwapsPer24Hours}.`,
    };
  }
  return { exceeded: false, reason: null };
}

type WalletActivitySettings = Pick<
  RiskSettings,
  | "maxWalletSwapsPerHour"
  | "maxWalletSwapsPer24Hours"
  | "hypercoreMaxWalletFillsPerHour"
  | "hypercoreMaxWalletFillsPer24Hours"
>;

export function walletActivityLimitsFor(chainId: ChainId, settings: WalletActivitySettings) {
  return chainId === "hyperliquid"
    ? {
        maxSwapsPerHour: settings.hypercoreMaxWalletFillsPerHour ?? 20,
        maxSwapsPer24Hours: settings.hypercoreMaxWalletFillsPer24Hours ?? 100,
      }
    : {
        maxSwapsPerHour: settings.maxWalletSwapsPerHour ?? 8,
        maxSwapsPer24Hours: settings.maxWalletSwapsPer24Hours ?? 50,
      };
}
import type { ChainId, RiskSettings } from "../domain/types.ts";
