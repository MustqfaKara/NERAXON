import test from "node:test";
import assert from "node:assert/strict";
import { calculateRobinhoodV4LiquidityUsd, DexScreenerMarketDataProvider } from "../src/lib/services/market-data-provider.ts";

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

test("Solana fiyatında manipüle quote havuzu yerine güvenilir SOL havuzunu seçer", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([
    {
      chainId: "solana",
      dexId: "meteora",
      pairAddress: "fake-pair",
      baseToken: { address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", symbol: "JUP" },
      quoteToken: { address: "METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL", symbol: "MET" },
      priceUsd: "948.043",
      liquidity: { usd: 389_847_486 },
      volume: { h24: 1_713_218_436 },
    },
    {
      chainId: "solana",
      dexId: "meteora",
      pairAddress: "trusted-pair",
      baseToken: { address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", symbol: "JUP" },
      quoteToken: { address: "So11111111111111111111111111111111111111112", symbol: "SOL" },
      priceUsd: "0.191",
      liquidity: { usd: 1_043_487 },
      volume: { h24: 566_438 },
    },
  ]), { status: 200 });

  try {
    const provider = new DexScreenerMarketDataProvider();
    const result = await provider.getTokenMarket("solana", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN");
    assert.equal(result.pairAddress, "trusted-pair");
    assert.equal(result.priceUsd, 0.191);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Robinhood v4 aktif likiditesini iki taraflı USD fiyat derinliğine çevirir", () => {
  const liquidityUsd = calculateRobinhoodV4LiquidityUsd(
    2_345_289_727_626_771_572n,
    1_082_894_435_954_053_359_931_045_313_440_985n,
    1_933.8,
  );
  assert.ok(liquidityUsd > 0.66 && liquidityUsd < 0.67);
  assert.equal(calculateRobinhoodV4LiquidityUsd(0n, 1n, 1_933.8), 0);
});

test("Robinhood fiyatında aykırı v4 havuzu güvenilir havuzların önüne geçemez", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([
    {
      chainId: "robinhood",
      dexId: "uniswap",
      pairAddress: "0x0000000000000000000000000000000000000011",
      baseToken: { address: "0x39dbed3a2bd333467115de45665cc57f813c4571", symbol: "PONS" },
      quoteToken: { address: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", symbol: "WETH" },
      priceNative: "0.00001601",
      priceUsd: "0.03088",
      liquidity: { usd: 1_338_408 },
      volume: { h24: 7_414_509 },
    },
    {
      chainId: "robinhood",
      dexId: "uniswap",
      pairAddress: "0x0000000000000000000000000000000000000022",
      baseToken: { address: "0x39dbed3a2bd333467115de45665cc57f813c4571", symbol: "PONS" },
      quoteToken: { address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", symbol: "USDG" },
      priceNative: "0.03094",
      priceUsd: "0.03096",
      liquidity: { usd: 625_408 },
      volume: { h24: 5_023_970 },
    },
    {
      chainId: "robinhood",
      dexId: "uniswap",
      pairAddress: "0x0000000000000000000000000000000000000033",
      baseToken: { address: "0x39dbed3a2bd333467115de45665cc57f813c4571", symbol: "PONS" },
      quoteToken: { address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", symbol: "USDG" },
      priceNative: "0.03091",
      priceUsd: "0.03093",
      liquidity: { usd: 133_343 },
      volume: { h24: 2_375_517 },
    },
    {
      chainId: "robinhood",
      dexId: "uniswap",
      pairAddress: `0x${"a".repeat(64)}`,
      baseToken: { address: "0x39dbed3a2bd333467115de45665cc57f813c4571", symbol: "PONS" },
      quoteToken: { address: "0x0000000000000000000000000000000000000000", symbol: "ETH" },
      priceNative: "329045927431445741327360",
      priceUsd: "6.35988691056855e+26",
      liquidity: { usd: 9_999_999_999 },
      volume: { h24: 0 },
    },
  ]), { status: 200 });

  try {
    const provider = new DexScreenerMarketDataProvider();
    const result = await provider.getTokenMarket("robinhood", "0x39dbed3a2bd333467115de45665cc57f813c4571");
    assert.equal(result.pairAddress, "0x0000000000000000000000000000000000000011");
    assert.equal(result.priceUsd, 0.03088);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
