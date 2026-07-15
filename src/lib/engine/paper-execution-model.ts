import type { TradeSide } from "@/lib/domain/types";

export interface PaperExecutionInput {
  side: TradeSide;
  quotedPriceUsd: number;
  grossUsd: number;
  liquidityUsd: number;
  slippagePercent: number;
  dexFeePercent: number;
  tokenTaxPercent: number;
  priceChange24hPercent: number;
  executionDelayMs: number;
  gasFeeUsd: number;
}

export function modelPaperExecution(input: PaperExecutionInput) {
  const delayMinutes = Math.max(0, input.executionDelayMs) / 60_000;
  const minuteVolatility = Math.abs(input.priceChange24hPercent) / (24 * 60);
  const delayImpactPercent = Math.min(1.5, minuteVolatility * delayMinutes * 0.35);
  const priceImpactPercent = Math.min(20, (input.grossUsd / Math.max(1, input.liquidityUsd)) * 100);
  const adversePercent = delayImpactPercent + (priceImpactPercent * 0.5);
  const priceMultiplier = input.side === "buy" ? 1 + adversePercent / 100 : 1 - adversePercent / 100;
  const fillPriceUsd = Math.max(Number.EPSILON, input.quotedPriceUsd * priceMultiplier);
  const dexFeeUsd = input.grossUsd * (Math.max(0, input.dexFeePercent) / 100);
  const slippageUsd = input.grossUsd * (Math.max(0, input.slippagePercent) / 100);
  const priceImpactUsd = input.grossUsd * (priceImpactPercent / 100);
  const tokenTaxUsd = input.grossUsd * (Math.max(0, input.tokenTaxPercent) / 100);
  const totalUsd = dexFeeUsd + input.gasFeeUsd + slippageUsd + priceImpactUsd + tokenTaxUsd;
  return {
    fillPriceUsd,
    delayImpactPercent,
    priceImpactPercent,
    fees: { dexFeeUsd, gasFeeUsd: input.gasFeeUsd, slippageUsd, priceImpactUsd, tokenTaxUsd, totalUsd },
  };
}

export function dexFeePercentFor(dexId?: string) {
  const normalized = dexId?.toLowerCase() ?? "";
  if (normalized.includes("uniswap")) return 0.3;
  if (normalized.includes("aerodrome")) return 0.3;
  if (normalized.includes("sushiswap")) return 0.3;
  if (normalized.includes("curve")) return 0.04;
  return 0.3;
}
