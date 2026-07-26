import assert from "node:assert/strict";
import test from "node:test";
import type { SocialTokenSignal } from "../src/lib/domain/types.ts";
import type { MarketSnapshot } from "../src/lib/services/market-data-provider.ts";
import {
  consolidateSocialSignals,
  shouldRequestSocialAi,
} from "../src/lib/engine/social-ai-policy.ts";

const market: MarketSnapshot = {
  chainId: "solana",
  tokenAddress: "TokenMint",
  tokenSymbol: "TOKEN",
  priceUsd: 0.01,
  liquidityUsd: 100_000,
  volume24hUsd: 500_000,
  priceChange24hPercent: 120,
  marketCapUsd: 1_500_000,
  fdvUsd: 1_500_000,
  pairAddress: "Pair",
  dexId: "dex",
  pairCreatedAt: null,
  fetchedAt: new Date().toISOString(),
};

function signal(overrides: Partial<SocialTokenSignal> = {}): SocialTokenSignal {
  return {
    id: "signal-1",
    chatId: "chat",
    chatTitle: "Grup",
    messageId: "message",
    chainId: "solana",
    dexScreenerChainId: "solana",
    tokenAddress: "TokenMint",
    tokenSymbol: "TOKEN",
    ticker: null,
    referenceType: "address",
    status: "analyzed",
    priceUsd: 0.01,
    liquidityUsd: 100_000,
    volume24hUsd: 500_000,
    priceChange24hPercent: 120,
    marketCapUsd: 1_500_000,
    pairAddress: "Pair",
    errorMessage: null,
    resolverVersion: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("uygun piyasa ilk sosyal AI değerlendirmesine gönderilir", () => {
  assert.equal(shouldRequestSocialAi(market, "current", []), true);
});

test("aynı token altı saat içinde yeniden AI değerlendirmesine gönderilmez", () => {
  assert.equal(shouldRequestSocialAi(market, "current", [signal()]), false);
});

test("zayıf likidite ve aşırı fiyat hareketi AI kotası tüketmez", () => {
  assert.equal(shouldRequestSocialAi({ ...market, liquidityUsd: 14_999 }, "current", []), false);
  assert.equal(shouldRequestSocialAi({ ...market, priceChange24hPercent: 1_001 }, "current", []), false);
});

test("aynı mesajdaki ticker ve tekrarlanan token tek satırda birleştirilir", () => {
  const ticker = signal({
    id: "ticker",
    tokenAddress: null,
    tokenSymbol: null,
    ticker: "TOKEN",
    referenceType: "ticker",
    status: "detected",
  });
  const repeated = signal({ id: "signal-2", messageId: "message-2" });
  assert.deepEqual(consolidateSocialSignals([ticker, signal(), repeated]).map((item) => item.id), ["signal-1"]);
});
