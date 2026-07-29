import assert from "node:assert/strict";
import test from "node:test";
import type { RiskSettings } from "../src/lib/domain/types.ts";
import { evaluateAssetExecutionPolicy } from "../src/lib/engine/asset-execution-policy.ts";

const baseAsset = "0x0000000000000000000000000000000000000001";
const settings: RiskSettings = {
  minPositionPercent: 8,
  maxPositionPercent: 15,
  dailyLossLimitPercent: 10,
  maxOpenPositions: 12,
  maxTokenExposurePercent: 20,
  maxWalletExposurePercent: 30,
  minimumLiquidityUsd: 50_000,
  maxSlippagePercent: 3,
  maxPriceImpactPercent: 3,
  cashReservePercent: 15,
  assetPolicy: {
    minimumSafetyScore: 55,
    youngPoolAgeMinutes: 30,
    youngPoolMinWallets: 3,
    youngPoolAllocationMultiplier: 0.5,
    requireVerifiedExitRoute: true,
    hypercoreMinVolume24hUsd: 100_000,
    hypercoreMinOpenInterestUsd: 100_000,
    trustedAssets: { ethereum: [], base: [], robinhood: [], solana: [], hyperliquid: [] },
    deniedAssets: { ethereum: [], base: [], robinhood: [], solana: [], hyperliquid: [] },
  },
};
const market = {
  chainId: "base" as const,
  tokenAddress: baseAsset,
  tokenSymbol: "TEST",
  priceUsd: 1,
  liquidityUsd: 100_000,
  volume24hUsd: 20_000,
  priceChange24hPercent: 1,
  marketCapUsd: 500_000,
  fdvUsd: 500_000,
  pairAddress: "0x0000000000000000000000000000000000000002",
  dexId: "test",
  pairCreatedAt: Date.now() - 60 * 60_000,
  fetchedAt: new Date().toISOString(),
};
const safety = { approved: true, warnings: [], reason: "ok", score: 80, checks: [] };

test("denylist trusted listesinden önce uygulanır", () => {
  const policySettings = structuredClone(settings);
  policySettings.assetPolicy!.trustedAssets.base = [baseAsset];
  policySettings.assetPolicy!.deniedAssets.base = [baseAsset.toUpperCase()];
  const result = evaluateAssetExecutionPolicy({ chainId: "base", asset: baseAsset, opensPosition: true, settings: policySettings, safety, market, exitRouteVerified: true });
  assert.equal(result.approved, false);
  assert.equal(result.denied, true);
});

test("denylist pozisyon çıkışını engellemez", () => {
  const policySettings = structuredClone(settings);
  policySettings.assetPolicy!.deniedAssets.base = [baseAsset];
  const result = evaluateAssetExecutionPolicy({ chainId: "base", asset: baseAsset, opensPosition: false, settings: policySettings });
  assert.equal(result.approved, true);
});

test("genç piyasa üç cüzdan ve doğrulanmış çıkış rotası ister", () => {
  const youngMarket = { ...market, pairCreatedAt: Date.now() - 5 * 60_000 };
  const missingWallet = evaluateAssetExecutionPolicy({ chainId: "base", asset: baseAsset, opensPosition: true, settings, safety, market: youngMarket, walletConfirmations: 2, exitRouteVerified: true });
  assert.equal(missingWallet.approved, false);
  const missingExit = evaluateAssetExecutionPolicy({ chainId: "base", asset: baseAsset, opensPosition: true, settings, safety, market: youngMarket, walletConfirmations: 3, exitRouteVerified: false });
  assert.equal(missingExit.approved, false);
  const approved = evaluateAssetExecutionPolicy({ chainId: "base", asset: baseAsset, opensPosition: true, settings, safety, market: youngMarket, walletConfirmations: 3, exitRouteVerified: true });
  assert.equal(approved.approved, true);
  assert.equal(approved.allocationMultiplier, 0.5);
});

test("HyperCore spot hacim, perp hacim ve açık pozisyon filtresini kullanır", () => {
  const lowSpot = evaluateAssetExecutionPolicy({ chainId: "hyperliquid", asset: "spot:HYPE", opensPosition: true, settings, marketType: "spot", volume24hUsd: 99_999 });
  assert.equal(lowSpot.approved, false);
  const lowPerpOi = evaluateAssetExecutionPolicy({ chainId: "hyperliquid", asset: "perp:ETH", opensPosition: true, settings, marketType: "perp", volume24hUsd: 200_000, openInterestUsd: 99_999 });
  assert.equal(lowPerpOi.approved, false);
  const approved = evaluateAssetExecutionPolicy({ chainId: "hyperliquid", asset: "perp:ETH", opensPosition: true, settings, marketType: "perp", volume24hUsd: 200_000, openInterestUsd: 200_000 });
  assert.equal(approved.approved, true);
});

test("trusted HyperCore piyasası otomatik hacim filtresini aşabilir", () => {
  const policySettings = structuredClone(settings);
  policySettings.assetPolicy!.trustedAssets.hyperliquid = ["PERP:ETH"];
  const result = evaluateAssetExecutionPolicy({ chainId: "hyperliquid", asset: "perp:eth", opensPosition: true, settings: policySettings, marketType: "perp", volume24hUsd: 1, openInterestUsd: 1 });
  assert.equal(result.approved, true);
  assert.equal(result.trusted, true);
});

test("Solana güçlü cüzdan ve doğrulanmış çıkışla likidite eşiğini kontrollü esnetir", () => {
  const solanaMarket = { ...market, chainId: "solana" as const, tokenAddress: "So11111111111111111111111111111111111111112", liquidityUsd: 26_000 };
  const approved = evaluateAssetExecutionPolicy({ chainId: "solana", asset: solanaMarket.tokenAddress, opensPosition: true, settings, safety, market: solanaMarket, walletScore: 78, walletConfirmations: 1, exitRouteVerified: true });
  assert.equal(approved.approved, true);
  const missingExit = evaluateAssetExecutionPolicy({ chainId: "solana", asset: solanaMarket.tokenAddress, opensPosition: true, settings, safety, market: solanaMarket, walletScore: 78, walletConfirmations: 1, exitRouteVerified: false });
  assert.equal(missingExit.approved, false);
});

test("65 skorlu cüzdan doğrulanmış çıkış ve güvenlik skoru ile esnek eşiği kullanır", () => {
  const baseMarket = { ...market, chainId: "base" as const, liquidityUsd: 15_000 };
  const approved = evaluateAssetExecutionPolicy({ chainId: "base", asset: baseMarket.tokenAddress, opensPosition: true, settings, safety, market: baseMarket, walletScore: 65, walletConfirmations: 1, exitRouteVerified: true });
  assert.equal(approved.approved, true);
  const belowScore = evaluateAssetExecutionPolicy({ chainId: "base", asset: baseMarket.tokenAddress, opensPosition: true, settings, safety, market: { ...baseMarket, liquidityUsd: 49_999 }, walletScore: 64, walletConfirmations: 1, exitRouteVerified: true });
  assert.equal(belowScore.approved, false);
});

test("Solana çok güçlü konsensüste 10000 USD altına inmez", () => {
  const solanaMarket = { ...market, chainId: "solana" as const, tokenAddress: "So11111111111111111111111111111111111111112", liquidityUsd: 9_999 };
  const result = evaluateAssetExecutionPolicy({ chainId: "solana", asset: solanaMarket.tokenAddress, opensPosition: true, settings, safety, market: solanaMarket, walletScore: 90, walletConfirmations: 3, exitRouteVerified: true });
  assert.equal(result.approved, false);
  assert.match(result.reason, /10000/);
});

test("Robinhood Portal likidite yerine doğrulanmış çift yönlü rota ve genç piyasa konsensüsü ister", () => {
  const portalMarket = {
    ...market,
    chainId: "robinhood" as const,
    liquidityUsd: 0,
    marketKind: "robinhood-portal" as const,
    exitRouteVerified: true,
    pairCreatedAt: Date.now() - 5 * 60_000,
  };
  const withoutConsensus = evaluateAssetExecutionPolicy({
    chainId: "robinhood",
    asset: portalMarket.tokenAddress,
    opensPosition: true,
    settings,
    safety,
    market: portalMarket,
    walletConfirmations: 1,
    exitRouteVerified: true,
  });
  assert.equal(withoutConsensus.approved, false);

  const approved = evaluateAssetExecutionPolicy({
    chainId: "robinhood",
    asset: portalMarket.tokenAddress,
    opensPosition: true,
    settings,
    safety,
    market: portalMarket,
    walletConfirmations: 3,
    exitRouteVerified: true,
  });
  assert.equal(approved.approved, true);
  assert.ok(approved.checks.some((check) => check.label === "Robinhood Portal"));
});
