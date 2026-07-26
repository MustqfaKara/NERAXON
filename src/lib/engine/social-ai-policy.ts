import type { SocialTokenSignal } from "@/lib/domain/types";
import type { MarketSnapshot } from "@/lib/services/market-data-provider";

export const SOCIAL_AI_COOLDOWN_MS = 6 * 60 * 60 * 1_000;

export function shouldRequestSocialAi(
  market: MarketSnapshot,
  currentSignalId: string,
  history: SocialTokenSignal[],
  now = Date.now(),
) {
  const marketCapUsd = market.marketCapUsd ?? market.fdvUsd;
  if (market.liquidityUsd < 15_000) return false;
  if (market.volume24hUsd < 50_000) return false;
  if (marketCapUsd === null || marketCapUsd < 25_000 || marketCapUsd > 20_000_000) return false;
  if (market.priceChange24hPercent < -70 || market.priceChange24hPercent > 1_000) return false;

  const normalizedAddress = normalizeAddress(market.chainId, market.tokenAddress);
  return !history.some((signal) =>
    signal.id !== currentSignalId
    && signal.chainId === market.chainId
    && signal.tokenAddress !== null
    && normalizeAddress(market.chainId, signal.tokenAddress) === normalizedAddress
    && now - Date.parse(signal.createdAt) < SOCIAL_AI_COOLDOWN_MS
  );
}

export function consolidateSocialSignals(signals: SocialTokenSignal[]) {
  const messagesWithAddress = new Set(
    signals
      .filter((signal) => signal.tokenAddress)
      .map((signal) => `${signal.chatId}:${signal.messageId}`),
  );
  const unique = new Map<string, SocialTokenSignal>();
  for (const signal of signals) {
    if (
      signal.referenceType === "ticker"
      && messagesWithAddress.has(`${signal.chatId}:${signal.messageId}`)
    ) continue;
    const marketChainId = signal.chainId ?? signal.dexScreenerChainId;
    const key = signal.tokenAddress && marketChainId
      ? `${marketChainId}:${normalizeAddress(marketChainId, signal.tokenAddress)}`
      : `${signal.chatId}:${signal.messageId}:${signal.ticker ?? signal.id}`;
    if (!unique.has(key)) unique.set(key, signal);
  }
  return [...unique.values()];
}

function normalizeAddress(chainId: string, address: string) {
  return chainId === "solana" ? address.trim() : address.trim().toLowerCase();
}
