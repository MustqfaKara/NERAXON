import { createHash } from "node:crypto";
import type { AiTradeAdvisory, ChainId, TradingMode } from "@/lib/domain/types";
import { GroqTradeAdvisor, type AiTradeContext } from "@/lib/ai/groq-trade-advisor";
import { store } from "@/lib/repositories/store";
import { monitorService } from "@/lib/services/service-health";

export interface TradeAdvisoryInput extends AiTradeContext {
  chainId: ChainId;
  mode: TradingMode;
  walletId: string | null;
  walletLabel: string | null;
  sourceReference: string;
  purpose?: "copy_trade" | "social_signal";
  purposeDailyLimit?: number;
}

const advisor = new GroqTradeAdvisor();
const pending = new Set<string>();

export function queueTradeAdvisory(input: TradeAdvisoryInput) {
  if (process.env.NERAXON_AI_ADVISOR_ENABLED?.trim().toLowerCase() === "false") return null;
  const id = advisoryId(input);
  if (pending.has(id) || store.hasAiTradeAdvisory(id)) return null;
  pending.add(id);
  return captureTradeAdvisory(id, input).finally(() => pending.delete(id));
}

async function captureTradeAdvisory(id: string, input: TradeAdvisoryInput) {
  const startedAt = performance.now();
  try {
    if (!store.reserveAiRequest(
      input.purpose ?? "copy_trade",
      100,
      input.purposeDailyLimit ?? 100,
    )) return false;
    await monitorService("groq_ai", async () => {
      const decision = await advisor.analyze(input);
      const advisory: AiTradeAdvisory = {
        id,
        chainId: input.chainId,
        mode: input.mode,
        side: input.side,
        asset: input.asset,
        walletId: input.walletId,
        walletLabel: input.walletLabel,
        sourceReference: input.sourceReference,
        recommendation: decision.recommendation,
        confidence: decision.confidence,
        riskLevel: decision.riskLevel,
        summaryTr: decision.summaryTr,
        summaryEn: decision.summaryEn,
        projectPurposeTr: decision.projectPurposeTr,
        projectPurposeEn: decision.projectPurposeEn,
        socialAssessmentTr: decision.socialAssessmentTr,
        socialAssessmentEn: decision.socialAssessmentEn,
        researchSources: [
          input.projectResearch?.website.url,
          ...(input.projectResearch?.xProfiles.map((profile) => profile.url) ?? []),
        ].filter((url): url is string => Boolean(url)),
        riskFlagsTr: decision.riskFlagsTr,
        riskFlagsEn: decision.riskFlagsEn,
        provider: "groq",
        model: advisor.model,
        latencyMs: Math.round(performance.now() - startedAt),
        createdAt: new Date().toISOString(),
      };
      store.insertAiTradeAdvisory(advisory);
    });
    return true;
  } catch (error) {
    console.error(
      `[NERAXON] AI görüşü kaydedilemedi (${input.asset}):`,
      error instanceof Error ? error.message : "Bilinmeyen hata",
    );
    // AI danışmanı fail-open çalışır; deterministik işlem motoruna hata taşımaz.
    return false;
  }
}

function advisoryId(input: TradeAdvisoryInput) {
  return createHash("sha256")
    .update(`${input.mode}:${input.chainId}:${input.sourceReference}:${input.side}:${input.asset}`)
    .digest("hex");
}
