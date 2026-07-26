import type { ChainId, RiskSettings } from "@/lib/domain/types";
import type { QuoteGuardAssessment } from "@/lib/execution/execution-quote-guard";
import { getNetworkExecutionLimit } from "@/lib/execution/network-execution-risk";
import { publishEvent } from "@/lib/services/audit-service";

export async function publishEmergencyExitDeviation(input: {
  chainId: ChainId;
  asset: string;
  assessment: QuoteGuardAssessment;
  settings: RiskSettings;
  txHash?: string | null;
}) {
  const normalSellLimit = getNetworkExecutionLimit(input.chainId, input.settings).maxSellPriceDeviationPercent;
  if (!input.assessment.emergencyExit || input.assessment.priceDeviationPercent <= normalSellLimit) return null;
  return publishEvent({
    chainId: input.chainId,
    level: "critical",
    type: "system",
    title: "Acil çıkış fiyat toleransı kullanıldı",
    message: `${input.asset} tam kapanışı normal %${normalSellLimit.toFixed(2)} satış sınırını aştı; pozisyon %${input.assessment.priceDeviationPercent.toFixed(2)} sapmayla güvenlik sınırı içinde kapatıldı.`,
    txHash: input.txHash ?? null,
  });
}
