import type { AssetPolicySettings, ChainId, RiskSettings } from "@/lib/domain/types";
import type { TokenSafetyResult } from "@/lib/engine/token-security";
import type { MarketSnapshot } from "@/lib/services/market-data-provider";

export interface AssetPolicyDecision {
  approved: boolean;
  asset: string;
  trusted: boolean;
  denied: boolean;
  youngMarket: boolean;
  exitRouteVerified: boolean;
  allocationMultiplier: number;
  reason: string;
  checks: Array<{ label: string; status: "passed" | "warning" | "failed"; detail: string }>;
}

export function evaluateAssetExecutionPolicy(input: {
  chainId: ChainId;
  asset: string;
  opensPosition: boolean;
  settings: RiskSettings;
  safety?: TokenSafetyResult;
  market?: MarketSnapshot;
  walletConfirmations?: number;
  walletScore?: number;
  exitRouteVerified?: boolean;
  marketType?: "spot" | "perp";
  volume24hUsd?: number;
  openInterestUsd?: number;
}): AssetPolicyDecision {
  const policy = requirePolicy(input.settings);
  const asset = normalizePolicyAsset(input.chainId, input.asset);
  const trusted = policy.trustedAssets[input.chainId].some((item) => normalizePolicyAsset(input.chainId, item) === asset);
  const denied = policy.deniedAssets[input.chainId].some((item) => normalizePolicyAsset(input.chainId, item) === asset);
  const checks: AssetPolicyDecision["checks"] = [];

  if (!input.opensPosition) return approve(asset, trusted, denied, false, true, 1, "Pozisyon çıkışı varlık filtresinden muaf.", checks);
  if (denied) return reject(asset, trusted, true, false, false, "Varlık manuel denylist içinde.", checks);
  checks.push({ label: "Manuel denylist", status: "passed", detail: "Varlık engelli listede değil." });

  if (input.chainId === "hyperliquid") {
    const volume24hUsd = finiteValue(input.volume24hUsd);
    const openInterestUsd = finiteValue(input.openInterestUsd);
    if (!trusted && volume24hUsd < policy.hypercoreMinVolume24hUsd) {
      return reject(asset, false, false, false, true, `HyperCore 24 saatlik hacmi ${policy.hypercoreMinVolume24hUsd.toFixed(0)} USD sınırının altında.`, checks);
    }
    checks.push({ label: "HyperCore hacmi", status: trusted ? "warning" : "passed", detail: `${volume24hUsd.toFixed(0)} USD 24 saatlik hacim.` });
    if (input.marketType === "perp" && !trusted && openInterestUsd < policy.hypercoreMinOpenInterestUsd) {
      return reject(asset, false, false, false, true, `HyperCore açık pozisyon değeri ${policy.hypercoreMinOpenInterestUsd.toFixed(0)} USD sınırının altında.`, checks);
    }
    if (input.marketType === "perp") checks.push({ label: "HyperCore açık pozisyon", status: trusted ? "warning" : "passed", detail: `${openInterestUsd.toFixed(0)} USD açık pozisyon.` });
    return approve(asset, trusted, false, false, true, 1, trusted ? "Trusted HyperCore piyasası zorunlu piyasa kimliği kontrolleriyle kabul edildi." : "HyperCore otomatik piyasa filtresi geçti.", checks);
  }

  if (!input.safety?.approved) return reject(asset, trusted, false, false, Boolean(input.exitRouteVerified), input.safety?.reason ?? "Token güvenlik değerlendirmesi bulunamadı.", checks);
  checks.push(...input.safety.checks);
  if (!trusted && input.safety.score < policy.minimumSafetyScore) {
    return reject(asset, false, false, false, Boolean(input.exitRouteVerified), `Token güvenlik skoru ${policy.minimumSafetyScore} sınırının altında.`, checks);
  }
  const minimumLiquidityUsd = resolveMinimumLiquidityUsd(input);
  if (!trusted && input.market && input.market.liquidityUsd < minimumLiquidityUsd) {
    return reject(asset, false, false, false, Boolean(input.exitRouteVerified), `Token likiditesi ${minimumLiquidityUsd.toFixed(0)} USD kalite eşiğinin altında.`, checks);
  }
  if (!trusted && input.market) checks.push({
    label: "Likidite",
    status: minimumLiquidityUsd < input.settings.minimumLiquidityUsd ? "warning" : "passed",
    detail: `${input.market.liquidityUsd.toFixed(0)} USD likidite; uygulanan eşik ${minimumLiquidityUsd.toFixed(0)} USD.`,
  });

  const ageMinutes = input.market?.pairCreatedAt ? Math.max(0, (Date.now() - input.market.pairCreatedAt) / 60_000) : Number.POSITIVE_INFINITY;
  const youngMarket = ageMinutes < policy.youngPoolAgeMinutes;
  if (youngMarket && !trusted && finiteValue(input.walletConfirmations) < policy.youngPoolMinWallets) {
    return reject(asset, false, false, true, Boolean(input.exitRouteVerified), `Genç piyasa için en az ${policy.youngPoolMinWallets} farklı cüzdan onayı gerekli.`, checks);
  }
  if (youngMarket && policy.requireVerifiedExitRoute && !input.exitRouteVerified) {
    return reject(asset, trusted, false, true, false, "Genç piyasa için doğrulanmış satış rotası bulunamadı.", checks);
  }
  if (youngMarket) checks.push({ label: "Genç piyasa", status: "warning", detail: `Pozisyon normal büyüklüğün %${(policy.youngPoolAllocationMultiplier * 100).toFixed(0)} kadarıyla sınırlandı.` });
  const liquidityMultiplier = input.market ? liquidityAllocationMultiplier(input.market.liquidityUsd, input.settings.minimumLiquidityUsd) : 1;
  return approve(asset, trusted, false, youngMarket, !youngMarket || Boolean(input.exitRouteVerified), Math.min(youngMarket ? policy.youngPoolAllocationMultiplier : 1, liquidityMultiplier), trusted ? "Trusted varlık zorunlu zincir kontrolleriyle kabul edildi." : "Varlık otomatik güvenlik politikasını geçti.", checks);
}

export function resolveMinimumLiquidityUsd(input: {
  chainId: ChainId;
  settings: RiskSettings;
  safety?: TokenSafetyResult;
  walletConfirmations?: number;
  walletScore?: number;
  exitRouteVerified?: boolean;
}) {
  const configured = input.settings.minimumLiquidityUsd;
  if (!["base", "robinhood", "solana"].includes(input.chainId) || !input.exitRouteVerified) return configured;
  const walletScore = finiteValue(input.walletScore);
  const safetyScore = finiteValue(input.safety?.score);
  const confirmations = finiteValue(input.walletConfirmations);
  if (walletScore >= 80 && safetyScore >= 70 && confirmations >= 3) return Math.min(configured, 10_000);
  if (walletScore >= 65 && safetyScore >= 65) return Math.min(configured, 15_000);
  return configured;
}

export function liquidityAllocationMultiplier(liquidityUsd: number, configuredMinimumUsd: number) {
  if (liquidityUsd < 15_000) return 0.25;
  if (liquidityUsd < configuredMinimumUsd) return 0.5;
  return 1;
}

export function normalizePolicyAsset(chainId: ChainId, asset: string) {
  const trimmed = asset.trim();
  if (chainId === "solana") return trimmed;
  const normalized = trimmed.toLowerCase();
  return chainId === "hyperliquid" && normalized.startsWith("spot:") ? normalized.replace(/\/usdc$/, "") : normalized;
}

function requirePolicy(settings: RiskSettings): AssetPolicySettings {
  if (!settings.assetPolicy) throw new Error("Varlık güvenlik politikası yapılandırılmadı.");
  return settings.assetPolicy;
}

function finiteValue(value: number | undefined) {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}

function approve(asset: string, trusted: boolean, denied: boolean, youngMarket: boolean, exitRouteVerified: boolean, allocationMultiplier: number, reason: string, checks: AssetPolicyDecision["checks"]): AssetPolicyDecision {
  return { approved: true, asset, trusted, denied, youngMarket, exitRouteVerified, allocationMultiplier, reason, checks };
}

function reject(asset: string, trusted: boolean, denied: boolean, youngMarket: boolean, exitRouteVerified: boolean, reason: string, checks: AssetPolicyDecision["checks"]): AssetPolicyDecision {
  return { approved: false, asset, trusted, denied, youngMarket, exitRouteVerified, allocationMultiplier: 0, reason, checks: [...checks, { label: "Varlık politikası", status: "failed", detail: reason }] };
}

export function assertAssetExecutionPolicy(input: Parameters<typeof evaluateAssetExecutionPolicy>[0]) {
  const decision = evaluateAssetExecutionPolicy(input);
  if (!decision.approved) throw new Error(decision.reason);
  return decision;
}

export function assertAssetNotDenied(chainId: ChainId, asset: string, settings: RiskSettings) {
  const policy = requirePolicy(settings);
  const normalizedAsset = normalizePolicyAsset(chainId, asset);
  if (policy.deniedAssets[chainId].some((item) => normalizePolicyAsset(chainId, item) === normalizedAsset)) {
    throw new Error("Varlık manuel denylist içinde.");
  }
}
