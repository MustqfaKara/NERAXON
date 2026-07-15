import type { Position, RiskSettings } from "@/lib/domain/types";

export interface RiskContext {
  equityUsd: number;
  cashBalanceUsd: number;
  openPositions: Position[];
  walletScore: number;
  liquidityUsd: number;
  slippagePercent: number;
  priceImpactPercent: number;
  dailyPnlUsd: number;
  tokenExposureUsd?: number;
  walletExposureUsd?: number;
  isExistingTokenPosition?: boolean;
  priceChange24hPercent?: number;
  circuitBreakerHalted?: boolean;
}

export interface RiskDecision {
  approved: boolean;
  allocationPercent: number;
  allocationUsd: number;
  reason: string;
}

export function evaluateBuy(settings: RiskSettings, context: RiskContext): RiskDecision {
  if (context.circuitBreakerHalted) return reject("Acil durum devre kesicisi aktif.");
  if (context.dailyPnlUsd <= -(context.equityUsd * settings.dailyLossLimitPercent) / 100) {
    return reject("Günlük zarar sınırı aşıldı.");
  }
  if (!context.isExistingTokenPosition && context.openPositions.length >= settings.maxOpenPositions) {
    return reject("Maksimum açık pozisyon sayısına ulaşıldı.");
  }
  if (context.liquidityUsd < settings.minimumLiquidityUsd) {
    return reject("Token likiditesi minimum sınırın altında.");
  }
  if (context.slippagePercent > settings.maxSlippagePercent) {
    return reject("Tahmini slippage izin verilen sınırın üzerinde.");
  }
  if (context.priceImpactPercent > settings.maxPriceImpactPercent) {
    return reject("Tahmini fiyat etkisi izin verilen sınırın üzerinde.");
  }
  if (Math.abs(context.priceChange24hPercent ?? 0) > (settings.maxPriceChange24hPercent ?? 80)) {
    return reject("Tokenin 24 saatlik fiyat hareketi izin verilen volatilite sınırını aşıyor.");
  }
  if (context.walletScore < 45) {
    return reject("Cüzdan skoru işlem açmak için yeterli değil.");
  }

  const scoreRatio = Math.min(1, Math.max(0, (context.walletScore - 45) / 40));
  const allocationPercent = settings.minPositionPercent +
    (settings.maxPositionPercent - settings.minPositionPercent) * scoreRatio;
  const desiredUsd = (context.equityUsd * allocationPercent) / 100;
  const reserveUsd = (context.equityUsd * settings.cashReservePercent) / 100;
  const allocationUsd = Math.max(0, Math.min(desiredUsd, context.cashBalanceUsd - reserveUsd));

  if ((context.tokenExposureUsd ?? 0) + allocationUsd > context.equityUsd * settings.maxTokenExposurePercent / 100) {
    return reject("Token bazlı maksimum portföy maruziyeti aşılacak.");
  }
  if ((context.walletExposureUsd ?? 0) + allocationUsd > context.equityUsd * settings.maxWalletExposurePercent / 100) {
    return reject("Cüzdan bazlı maksimum portföy maruziyeti aşılacak.");
  }

  if (allocationUsd < 1) return reject("Nakit rezervi korunduktan sonra işlem için yeterli bakiye yok.");
  return {
    approved: true,
    allocationPercent: Number(allocationPercent.toFixed(2)),
    allocationUsd: Number(allocationUsd.toFixed(4)),
    reason: `Risk kontrolleri geçti; portföyün %${allocationPercent.toFixed(1)} kadarı ayrıldı.`,
  };
}

function reject(reason: string): RiskDecision {
  return { approved: false, allocationPercent: 0, allocationUsd: 0, reason };
}
