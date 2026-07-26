import type { WalletState } from "@/lib/domain/types";

export function isWalletEligibleForCopy(state: WalletState) {
  return state !== "paused";
}
