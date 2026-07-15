import test from "node:test";
import assert from "node:assert/strict";
import { DexScreenerMarketDataProvider } from "../src/lib/services/market-data-provider.ts";

test("en yüksek likiditeli token havuzunu seçer", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([
    {
      chainId: "base",
      dexId: "aerodrome",
      pairAddress: "0x0000000000000000000000000000000000000011",
      baseToken: { address: "0x0000000000000000000000000000000000000001", symbol: "TEST" },
      priceUsd: "1.25",
      liquidity: { usd: 25_000 },
      volume: { h24: 5_000 },
    },
    {
      chainId: "base",
      dexId: "uniswap",
      pairAddress: "0x0000000000000000000000000000000000000022",
      baseToken: { address: "0x0000000000000000000000000000000000000001", symbol: "TEST" },
      priceUsd: "1.2",
      liquidity: { usd: 150_000 },
      volume: { h24: 50_000 },
    },
  ]), { status: 200 });

  try {
    const provider = new DexScreenerMarketDataProvider();
    const result = await provider.getTokenMarket("base", "0x0000000000000000000000000000000000000001");
    assert.equal(result.dexId, "uniswap");
    assert.equal(result.liquidityUsd, 150_000);
    assert.equal(result.priceUsd, 1.2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tokenları toplu çözer ve tüm pool adreslerini döndürür", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    const pairs = [
      {
        chainId: "base",
        dexId: "aerodrome",
        pairAddress: "0x0000000000000000000000000000000000000011",
        baseToken: { address: "0x0000000000000000000000000000000000000001", symbol: "ONE" },
        quoteToken: { address: "0x0000000000000000000000000000000000000009", symbol: "USDC" },
        priceUsd: "1",
        liquidity: { usd: 50_000 },
        volume: { h24: 10_000 },
        priceChange: { h24: 12 },
      },
      {
        chainId: "base",
        dexId: "uniswap",
        pairAddress: "0x0000000000000000000000000000000000000022",
        baseToken: { address: "0x0000000000000000000000000000000000000001", symbol: "ONE" },
        quoteToken: { address: "0x0000000000000000000000000000000000000008", symbol: "WETH" },
        priceUsd: "1.01",
        liquidity: { usd: 40_000 },
        volume: { h24: 8_000 },
        priceChange: { h24: 11 },
      },
    ];
    return new Response(JSON.stringify(url.includes("token-pairs") ? pairs : pairs), { status: 200 });
  };

  try {
    const provider = new DexScreenerMarketDataProvider();
    const address = "0x0000000000000000000000000000000000000001";
    const markets = await provider.getTokenMarkets("base", [address]);
    const pools = await provider.getTokenPoolAddresses("base", [address]);
    assert.equal(markets.length, 1);
    assert.equal(markets[0].priceChange24hPercent, 12);
    assert.deepEqual(pools[address], [
      "0x0000000000000000000000000000000000000011",
      "0x0000000000000000000000000000000000000022",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("zorunlu yenilemede önbelleği atlayıp güncel fiyatı alır", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return new Response(JSON.stringify([{
      chainId: "base",
      dexId: "aerodrome",
      pairAddress: "0x0000000000000000000000000000000000000011",
      baseToken: { address: "0x0000000000000000000000000000000000000001", symbol: "TEST" },
      priceUsd: requestCount === 1 ? "1" : "1.2",
      liquidity: { usd: 50_000 },
      volume: { h24: 10_000 },
    }]), { status: 200 });
  };

  try {
    const provider = new DexScreenerMarketDataProvider();
    const address = "0x0000000000000000000000000000000000000001";
    const initial = await provider.getTokenMarkets("base", [address]);
    const cached = await provider.getTokenMarkets("base", [address]);
    const refreshed = await provider.getTokenMarkets("base", [address], { forceRefresh: true });

    assert.equal(initial[0].priceUsd, 1);
    assert.equal(cached[0].priceUsd, 1);
    assert.equal(refreshed[0].priceUsd, 1.2);
    assert.equal(requestCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
