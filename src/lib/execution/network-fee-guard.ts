import type { ChainId, NetworkFeeLimit, RiskSettings } from "@/lib/domain/types";

const FALLBACK_LIMITS: Record<ChainId, NetworkFeeLimit> = {
  ethereum: { maxFeeUsd: 1, maxFeePercent: 10 },
  base: { maxFeeUsd: 0.2, maxFeePercent: 5 },
  robinhood: { maxFeeUsd: 0.2, maxFeePercent: 8 },
  solana: { maxFeeUsd: 0.2, maxFeePercent: 8 },
  hyperliquid: { maxFeeUsd: 0.05, maxFeePercent: 2 },
};

export interface NetworkFeeAssessment {
  totalFeeUsd: number;
  feePercent: number;
  effectiveMaxFeeUsd: number;
  limit: NetworkFeeLimit;
}

export function getNetworkFeeLimit(chainId: ChainId, settings: RiskSettings): NetworkFeeLimit {
  return settings.networkFeeLimits?.[chainId] ?? FALLBACK_LIMITS[chainId];
}

export function assertNetworkFeeLimit(input: {
  chainId: ChainId;
  tradeUsd: number;
  networkFeeUsd?: number;
  venueFeeUsd?: number;
  emergencyExit?: boolean;
  settings: RiskSettings;
}): NetworkFeeAssessment {
  const tradeUsd = finiteNonNegative(input.tradeUsd, "İşlem değeri");
  if (tradeUsd <= 0) throw new Error("Fee oranı için işlem USD değeri doğrulanamadı.");

  const networkFeeUsd = finiteNonNegative(input.networkFeeUsd ?? 0, "Ağ ücreti");
  const venueFeeUsd = finiteNonNegative(input.venueFeeUsd ?? 0, "DEX/borsa ücreti");
  const totalFeeUsd = networkFeeUsd + venueFeeUsd;
  const limit = getNetworkFeeLimit(input.chainId, input.settings);
  const ratioLimitUsd = tradeUsd * limit.maxFeePercent / 100;
  const effectiveMaxFeeUsd = input.emergencyExit
    ? limit.maxFeeUsd
    : Math.min(limit.maxFeeUsd, ratioLimitUsd);
  const feePercent = totalFeeUsd / tradeUsd * 100;

  if (totalFeeUsd > effectiveMaxFeeUsd + Number.EPSILON) {
    throw new Error(
      `Tahmini toplam fee ${totalFeeUsd.toFixed(4)} USD (%${feePercent.toFixed(2)}) ile ${input.chainId} sınırını aşıyor. `
      + (input.emergencyExit
        ? `Tam pozisyon çıkışında izin verilen mutlak tavan ${limit.maxFeeUsd.toFixed(2)} USD.`
        : `İzin verilen: en fazla ${limit.maxFeeUsd.toFixed(2)} USD ve işlem değerinin %${limit.maxFeePercent.toFixed(2)} oranı.`),
    );
  }

  return { totalFeeUsd, feePercent, effectiveMaxFeeUsd, limit };
}

function finiteNonNegative(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} geçerli bir pozitif sayı olmalı.`);
  return value;
}
