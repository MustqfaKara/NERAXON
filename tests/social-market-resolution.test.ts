import assert from "node:assert/strict";
import test from "node:test";
import { pairToSocialMarket } from "../src/lib/engine/social-market-pair.ts";

test("desteklenmeyen DexScreener ağındaki tokenı piyasa takibi için çözer", () => {
  const market = pairToSocialMarket({
    chainId: "stable",
    dexId: "uniswap",
    pairAddress: "0x2f58e9ca6d919f2369c43f3a5d10959513218b9c",
    baseToken: {
      address: "0x0Cb340e449Ab2c4cBCBB08021f6Ae1ae838F2Fe2",
      symbol: "GREEN",
    },
    quoteToken: {
      address: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
      symbol: "USDT0",
    },
    priceUsd: "0.0002115",
    priceNative: "0.0002115",
    liquidity: { usd: 47_964.48 },
    volume: { h24: 35_226.19 },
    priceChange: { h24: 6_878 },
    marketCap: 211_563,
    fdv: 211_563,
  }, "0x0cb340e449ab2c4cbcbb08021f6ae1ae838f2fe2");

  assert.equal(market?.chainId, null);
  assert.equal(market?.dexScreenerChainId, "stable");
  assert.equal(market?.tokenSymbol, "GREEN");
  assert.equal(market?.marketCapUsd, 211_563);
  assert.equal(market?.pairAddress, "0x2f58e9ca6d919f2369c43f3a5d10959513218b9c");
});

test("desteklenen DexScreener ağını işlem ağı kimliğiyle eşler", () => {
  const market = pairToSocialMarket({
    chainId: "base",
    pairAddress: "0x0000000000000000000000000000000000000002",
    baseToken: {
      address: "0x0000000000000000000000000000000000000001",
      symbol: "TEST",
    },
    priceUsd: "1.25",
    liquidity: { usd: 50_000 },
  });

  assert.equal(market?.chainId, "base");
  assert.equal(market?.dexScreenerChainId, "base");
});
