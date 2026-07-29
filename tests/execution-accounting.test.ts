import test from "node:test";
import assert from "node:assert/strict";
import type { ExecutionLot } from "../src/lib/domain/types.ts";
import {
  calculateBalanceDifference,
  calculateLiveAccountPnl,
  calculatePortfolioEquity,
  consumedExecutionCost,
  executionLotQuantity,
  executionLotValueUsd,
  remainingExecutionCost,
  resolveExposureLimitUsd,
  executionLotHasRealizedOutcome,
  shouldInitializeLiveFundingBaseline,
} from "../src/lib/engine/execution-accounting-math.ts";
import {
  INTEGRATION_CATALOG,
  isShadowTestIntegration,
  SHADOW_TEST_BALANCE_USD,
  SHADOW_TEST_INTEGRATION_IDS,
} from "../src/lib/domain/integrations.ts";

const baseLot = (overrides: Partial<ExecutionLot> = {}): ExecutionLot => ({
  id: "lot-1",
  integrationId: "base",
  mode: "shadow",
  assetKey: "0xtoken",
  walletId: "wallet-1",
  source: "copy",
  marketType: "evm",
  positionSide: null,
  amount: "500000000000000000",
  initialAmount: "1000000000000000000",
  amountFormat: "base_units",
  assetSymbol: "TEST",
  assetDecimals: 18,
  entryPriceUsd: 10,
  currentPriceUsd: 12,
  entryCostUsd: 10,
  realizedPnlUsd: 0,
  feesUsd: 0.1,
  leverage: 1,
  entryReference: null,
  status: "open",
  openedAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
  ...overrides,
});

test("shadow lotunun kalan maliyetini ve güncel değerini açık miktara göre hesaplar", () => {
  const lot = baseLot();
  assert.equal(executionLotQuantity(lot), 0.5);
  assert.equal(remainingExecutionCost(lot), 5);
  assert.equal(executionLotValueUsd(lot), 6);
});

test("FIFO shadow satışında tüketilen maliyet yalnızca satılan miktarı kapsar", () => {
  const first = baseLot({ id: "first", amount: "1000000000000000000" });
  const second = baseLot({ id: "second", entryCostUsd: 20, amount: "1000000000000000000", initialAmount: "1000000000000000000" });
  assert.equal(consumedExecutionCost([first, second], "1500000000000000000"), 20);
});

test("HyperCore short lot değeri fiyat düşünce artar", () => {
  const lot = baseLot({
    integrationId: "hyperliquid",
    assetKey: "perp:btc",
    marketType: "perp",
    positionSide: "short",
    amountFormat: "decimal",
    amount: "0.1",
    initialAmount: "0.1",
    assetDecimals: 0,
    entryPriceUsd: 100,
    currentPriceUsd: 90,
    entryCostUsd: 5,
  });
  assert.equal(executionLotValueUsd(lot), 6);
});

test("ağ minimum emri yüzde maruziyet tavanından büyükse minimum emir uygulanabilir kalır", () => {
  assert.equal(resolveExposureLimitUsd(33.33, 20, 10.5), 10.5);
  assert.equal(resolveExposureLimitUsd(100, 20, 10.5), 20);
});

test("HyperCore tick minimumu sabit minimumdan büyükse yalnızca tek uygulanabilir pozisyona izin verir", () => {
  const limitUsd = resolveExposureLimitUsd(20.26283898, 20, 10.5, 14.99784741);
  assert.equal(limitUsd, 14.99784741);
  assert.ok(14.99784741 <= limitUsd);
  assert.ok(14.99784741 * 2 > limitUsd);
});

test("kısmi satış gerçekleşen PnL ürettiyse açık lot performans sonucuna dahil edilir", () => {
  assert.equal(executionLotHasRealizedOutcome(baseLot({ status: "open", realizedPnlUsd: 1.25 })), true);
  assert.equal(executionLotHasRealizedOutcome(baseLot({ status: "closed", realizedPnlUsd: 0 })), false);
});

test("ilk shadow testi yalnızca üç ağa eşit sanal bütçe ayırır", () => {
  assert.deepEqual(SHADOW_TEST_INTEGRATION_IDS, ["base", "solana", "hyperliquid"]);
  assert.equal(SHADOW_TEST_BALANCE_USD, 33.33);
  assert.equal(SHADOW_TEST_INTEGRATION_IDS.length * SHADOW_TEST_BALANCE_USD, 99.99);
  assert.equal(isShadowTestIntegration("base"), true);
  assert.equal(isShadowTestIntegration("ethereum"), false);
  assert.equal(isShadowTestIntegration("robinhood"), false);
  assert.equal(INTEGRATION_CATALOG.base.nativeSymbol, "ETH");
  assert.equal(INTEGRATION_CATALOG.solana.nativeSymbol, "SOL");
  assert.equal(INTEGRATION_CATALOG.hyperliquid.nativeSymbol, "USDC");
});

test("portföy özsermayesi likit, pozisyon ve iade edilebilir rezervden oluşur", () => {
  assert.equal(calculatePortfolioEquity(8.39, 0.632, 0.319).toFixed(3), "9.341");
});

test("boş canlı hesaba gelen ilk finansman PnL yerine başlangıç sermayesi olur", () => {
  assert.equal(shouldInitializeLiveFundingBaseline({
    initialEquityUsd: 0,
    currentEquityUsd: 18.75,
    hasExecutionHistory: false,
  }), true);
});

test("işlem geçmişi bulunan hesaptaki bakiye değişimi başlangıç sermayesini sıfırlamaz", () => {
  assert.equal(shouldInitializeLiveFundingBaseline({
    initialEquityUsd: 0,
    currentEquityUsd: 18.75,
    hasExecutionHistory: true,
  }), false);
  assert.equal(shouldInitializeLiveFundingBaseline({
    initialEquityUsd: 9.5,
    currentEquityUsd: 18.75,
    hasExecutionHistory: false,
  }), false);
});

test("açıklanamayan bakiye farkı gerçekleşen ve açık PnL'den ayrı tutulur", () => {
  assert.equal(calculateBalanceDifference({
    equityUsd: 9.341,
    startingEquityUsd: 9.454,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: -0.016,
  }).toFixed(3), "-0.097");
});

test("canlı net PnL günlük sıfırlama yerine ilk yatırılan özsermayeyi kullanır", () => {
  const result = calculateLiveAccountPnl({
    equityUsd: 46.6289,
    initialEquityUsd: 49.6305,
    dailyStartEquityUsd: 46.9371,
    executionRealizedPnlUsd: -1.5805,
    unrealizedPnlUsd: 0,
  });

  assert.equal(result.totalPnlUsd.toFixed(4), "-3.0016");
  assert.equal(result.realizedPnlUsd.toFixed(4), "-3.0016");
  assert.equal(result.dailyPnlUsd.toFixed(4), "-0.3082");
  assert.equal(result.accountDifferenceUsd.toFixed(4), "-1.4211");
});

test("hesap farkında açık pozisyon PnL değerini ikinci kez düşmez", () => {
  const result = calculateLiveAccountPnl({
    equityUsd: 11,
    initialEquityUsd: 10,
    dailyStartEquityUsd: 10,
    executionRealizedPnlUsd: 0.8,
    unrealizedPnlUsd: 0.5,
  });

  assert.equal(result.totalPnlUsd, 1);
  assert.equal(result.realizedPnlUsd, 0.5);
  assert.equal(result.accountDifferenceUsd.toFixed(2), "0.20");
});
