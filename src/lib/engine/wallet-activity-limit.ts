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
