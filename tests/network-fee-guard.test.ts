import assert from "node:assert/strict";
import test from "node:test";
import type { RiskSettings } from "../src/lib/domain/types.ts";
import { assertNetworkFeeLimit, getNetworkFeeLimit } from "../src/lib/execution/network-fee-guard.ts";

const settings: RiskSettings = {
  minPositionPercent: 5,
  maxPositionPercent: 10,
  dailyLossLimitPercent: 8,
  maxOpenPositions: 6,
  maxTokenExposurePercent: 15,
  maxWalletExposurePercent: 25,
  minimumLiquidityUsd: 50_000,
  maxSlippagePercent: 2,
  maxPriceImpactPercent: 2.5,
  cashReservePercent: 20,
  networkFeeLimits: {
    ethereum: { maxFeeUsd: 1, maxFeePercent: 10 },
    base: { maxFeeUsd: 0.2, maxFeePercent: 5 },
    robinhood: { maxFeeUsd: 0.2, maxFeePercent: 5 },
    solana: { maxFeeUsd: 0.2, maxFeePercent: 8 },
    hyperliquid: { maxFeeUsd: 0.05, maxFeePercent: 2 },
  },
};

test("ağ ve venue ücretleri toplam fee olarak değerlendirilir", () => {
  const result = assertNetworkFeeLimit({
    chainId: "base",
    tradeUsd: 10,
    networkFeeUsd: 0.03,
    venueFeeUsd: 0.02,
    settings,
  });

  assert.equal(result.totalFeeUsd, 0.05);
  assert.equal(result.feePercent, 0.5);
  assert.equal(result.effectiveMaxFeeUsd, 0.2);
});

test("mutlak USD tavanı aşılırsa emir reddedilir", () => {
  assert.throws(
    () => assertNetworkFeeLimit({ chainId: "base", tradeUsd: 10, networkFeeUsd: 0.21, settings }),
    /Tahmini toplam fee.*base sınırını aşıyor/,
  );
});

test("küçük işlemde oransal tavan mutlak tavandan önce uygulanır", () => {
  assert.throws(
    () => assertNetworkFeeLimit({ chainId: "solana", tradeUsd: 1, networkFeeUsd: 0.09, settings }),
    /%9\.00/,
  );
});

test("tam çıkışta oransal fee sınırı esner ancak mutlak tavan korunur", () => {
  const accepted = assertNetworkFeeLimit({
    chainId: "base",
    tradeUsd: 0.3,
    networkFeeUsd: 0.02,
    emergencyExit: true,
    settings,
  });
  assert.equal(accepted.effectiveMaxFeeUsd, 0.2);

  assert.throws(
    () => assertNetworkFeeLimit({
      chainId: "base",
      tradeUsd: 0.3,
      networkFeeUsd: 0.21,
      emergencyExit: true,
      settings,
    }),
    /mutlak tavan 0\.20 USD/,
  );
});

test("tam sınırdaki fee kabul edilir", () => {
  const result = assertNetworkFeeLimit({ chainId: "hyperliquid", tradeUsd: 2.5, venueFeeUsd: 0.05, settings });
  assert.equal(result.feePercent, 2);
  assert.equal(result.effectiveMaxFeeUsd, 0.05);
});

test("PYSCRIPT büyüklüğündeki Base işlemi gerçekçi fee tahminiyle kabul edilir", () => {
  const result = assertNetworkFeeLimit({
    chainId: "base",
    tradeUsd: 0.258,
    networkFeeUsd: 0.0059,
    venueFeeUsd: 0.0008,
    settings,
  });

  assert.ok(result.feePercent < 5);
  assert.equal(result.effectiveMaxFeeUsd, 0.0129);
});

test("eski ayarlarda ağ varsayılanı güvenli biçimde kullanılır", () => {
  const legacySettings = { ...settings, networkFeeLimits: undefined };
  assert.deepEqual(getNetworkFeeLimit("ethereum", legacySettings), { maxFeeUsd: 1, maxFeePercent: 10 });
});
