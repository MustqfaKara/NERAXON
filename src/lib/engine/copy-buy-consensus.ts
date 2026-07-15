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
  return {
    requiredWalletCount,
    shouldCopy: input.isNewWallet && !input.hasPendingStage && input.distinctWalletCount >= requiredWalletCount,
  };
}
