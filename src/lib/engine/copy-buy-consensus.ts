export function requiredWalletCountForNextBuy(completedBuyStages: number): number {
  const safeStageCount = Math.max(0, Math.floor(completedBuyStages));
  return (2 ** (safeStageCount + 1)) - 1;
}

export function canTriggerNextBuy(input: {
  completedBuyStages: number;
  distinctWalletCount: number;
  isNewWallet: boolean;
  hasPendingStage: boolean;
}) {
  const requiredWalletCount = requiredWalletCountForNextBuy(input.completedBuyStages);
  const reason = !input.isNewWallet
    ? "duplicate_wallet"
    : input.hasPendingStage
      ? "stage_pending"
      : input.distinctWalletCount < requiredWalletCount
        ? "threshold_wait"
        : "ready";
  return {
    requiredWalletCount,
    shouldCopy: input.isNewWallet && !input.hasPendingStage && input.distinctWalletCount >= requiredWalletCount,
    reason,
  };
}
