import type { ChainId, RiskSettings } from "@/lib/domain/types";
import { getNetworkExecutionLimit } from "./network-execution-risk.ts";

export class StaleQuoteError extends Error {}

export interface QuoteGuardAssessment {
  quoteAgeMs: number;
  quoteRefreshed: boolean;
  referencePriceUsd: number;
  quotedPriceUsd: number;
  priceDeviationPercent: number;
  allowedDeviationPercent: number;
  emergencyExit: boolean;
}

export async function prepareFreshQuote<T>(input: {
  chainId: ChainId;
  settings: RiskSettings;
  prepare: () => Promise<T>;
  quotedAt: (plan: T) => string;
}) {
  let plan = await input.prepare();
  let quoteRefreshed = false;
  try {
    assertQuoteAge(input.chainId, input.quotedAt(plan), input.settings);
  } catch (error) {
    if (!(error instanceof StaleQuoteError)) throw error;
    plan = await input.prepare();
    quoteRefreshed = true;
    assertQuoteAge(input.chainId, input.quotedAt(plan), input.settings);
  }
  return { plan, quoteRefreshed };
}

export function assertQuoteAge(chainId: ChainId, quotedAt: string, settings: RiskSettings, now = Date.now()) {
  const quotedAtMs = new Date(quotedAt).getTime();
  if (!Number.isFinite(quotedAtMs)) throw new StaleQuoteError(`${chainId} quote zamanı doğrulanamadı.`);
  const quoteAgeMs = Math.max(0, now - quotedAtMs);
  const maxQuoteAgeMs = getNetworkExecutionLimit(chainId, settings).maxQuoteAgeMs;
  if (quoteAgeMs > maxQuoteAgeMs) throw new StaleQuoteError(`${chainId} quote ${quoteAgeMs} ms ile ${maxQuoteAgeMs} ms yaş sınırını aşıyor.`);
  return quoteAgeMs;
}

export function assertPriceDeviation(input: {
  chainId: ChainId;
  side: "buy" | "sell";
  referencePriceUsd: number;
  quotedPriceUsd: number;
  quotedAt: string;
  quoteRefreshed: boolean;
  emergencyExit?: boolean;
  settings: RiskSettings;
}): QuoteGuardAssessment {
  if (!Number.isFinite(input.referencePriceUsd) || input.referencePriceUsd <= 0) throw new Error("Referans piyasa fiyatı doğrulanamadı.");
  if (!Number.isFinite(input.quotedPriceUsd) || input.quotedPriceUsd <= 0) throw new Error("Quote gerçekleşme fiyatı doğrulanamadı.");
  const limit = getNetworkExecutionLimit(input.chainId, input.settings);
  const emergencyExit = input.side === "sell" && Boolean(input.emergencyExit);
  const allowedDeviationPercent = emergencyExit
    ? limit.maxEmergencyExitDeviationPercent
    : input.side === "buy" ? limit.maxBuyPriceDeviationPercent : limit.maxSellPriceDeviationPercent;
  const priceDeviationPercent = Math.abs(input.quotedPriceUsd / input.referencePriceUsd - 1) * 100;
  if (priceDeviationPercent > allowedDeviationPercent + 1e-9) {
    throw new Error(`${input.chainId} quote fiyat sapması %${priceDeviationPercent.toFixed(2)} ile %${allowedDeviationPercent.toFixed(2)} sınırını aşıyor.`);
  }
  return {
    quoteAgeMs: assertQuoteAge(input.chainId, input.quotedAt, input.settings),
    quoteRefreshed: input.quoteRefreshed,
    referencePriceUsd: input.referencePriceUsd,
    quotedPriceUsd: input.quotedPriceUsd,
    priceDeviationPercent,
    allowedDeviationPercent,
    emergencyExit,
  };
}
