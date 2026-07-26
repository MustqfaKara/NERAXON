import { INTEGRATION_IDS, isLivePilotIntegration } from "@/lib/domain/integrations";
import type { ChainId, IntegrationLiveReadiness, LiveReadiness, LiveReadinessCheck } from "@/lib/domain/types";
import { getStoredCredentialStatusSync } from "@/lib/security/keychain";
import { store } from "@/lib/repositories/store";
import { certificationStatus } from "@/lib/services/live-certification";
import { configuredAllowedTargets } from "@/lib/execution/live-execution-guard";
import { getExecutionAccount } from "@/lib/services/execution-account-service";
import { getNetworkFeeLimit } from "@/lib/execution/network-fee-guard";
import { getNetworkExecutionLimit } from "@/lib/execution/network-execution-risk";
import { readCredentialSync, type CredentialId } from "@/lib/security/credential-vault";

const enabled = (value: string | undefined) => value?.trim().toLowerCase() === "true";

const check = (id: string, label: string, ready: boolean, detail: string): LiveReadinessCheck => ({
  id,
  label,
  ready,
  detail,
});

function executionSafetyCheck(chainId: ChainId) {
  const unresolvedCount = store.countUnresolvedLiveExecutionAttempts(chainId);
  return check(
    "execution_safety",
    "Idempotency ve emir mutabakatı",
    unresolvedCount === 0,
    unresolvedCount ? `${unresolvedCount} belirsiz veya başarısız mutabakat kaydı çözülmeli.` : "Çift gönderim koruması ve ağ referansı mutabakatı hazır.",
  );
}

function evmReadiness(chainId: Exclude<ChainId, "hyperliquid" | "solana">): IntegrationLiveReadiness {
  const prefix = chainId.toUpperCase();
  const rpcCredential = `${chainId}-rpc-url` as CredentialId;
  const credential = getStoredCredentialStatusSync("evm");
  const account = getExecutionAccount("evm");
  const risk = store.getRiskSettings();
  const reconciliation = store.listReconciliation().find((item) => item.integrationId === chainId);
  const certification = certificationStatus(chainId);
  const feeLimit = getNetworkFeeLimit(chainId, risk);
  const executionLimit = getNetworkExecutionLimit(chainId, risk);
  const assetPolicy = risk.assetPolicy!;
  const checks = [
    check("kill_switch", "Canlı işlem anahtarı", enabled(process.env.LIVE_TRADING_ENABLED), "LIVE_TRADING_ENABLED=true olmalı."),
    check("rpc", "Özel RPC", Boolean(readCredentialSync(rpcCredential)), `${prefix}_RPC_URL yapılandırılmalı.`),
    check("wallet", "Shadow işlem hesabı", Boolean(account), account ? `Public adres: ${account}` : "Shadow quote ve bakiye simülasyonu için EVM public adresi girilmeli."),
    check("signer", "macOS Keychain imzalayıcısı", credential.configured, "Private key yalnızca macOS Keychain içinde tutulmalı."),
    check("quote", "Swap yürütme sağlayıcısı", chainId === "robinhood" || Boolean(readCredentialSync("zerox-api-key")), chainId === "robinhood" ? "Uniswap v4 Quoter zincir üstünden kullanılıyor." : "0x API anahtarı yapılandırılmalı."),
    check("allowlist", "Swap yürütme güvenliği", configuredAllowedTargets(chainId).length > 0, chainId === "robinhood" ? "Universal Router kod içinde doğrulanıyor." : "Resmî 0x/LI.FI kaynakları, yürütme hedefi ve allowance spender kod içinde doğrulanıyor."),
    check("risk_limits", "Canlı risk tavanları", executionLimit.maxTradeUsd > 0 && feeLimit.maxFeeUsd > 0 && feeLimit.maxFeePercent > 0, `İşlem ${executionLimit.maxTradeUsd.toFixed(2)} USD; toplam fee ${feeLimit.maxFeeUsd.toFixed(2)} USD ve %${feeLimit.maxFeePercent.toFixed(2)} ile sınırlı.`),
    check("asset_policy", "Varlık güvenlik politikası", assetPolicy.minimumSafetyScore > 0 && assetPolicy.requireVerifiedExitRoute, `Güvenlik skoru ${assetPolicy.minimumSafetyScore}; genç piyasalarda çıkış rotası zorunlu.`),
    check("adapter", "Canlı EVM adaptörü", true, chainId === "robinhood" ? "Uniswap v4 adapter sözleşmesi hazır." : "Ortak EvmExecutionAdapter ve 0x yürütücüsü hazır."),
    check("copy_execution", "Canlı copy trade yönlendirmesi", true, "Mode bazlı konsensüs ve kaynak-cüzdan execution lotları hazır."),
    executionSafetyCheck(chainId),
    check("certification", "Mikro canlı işlem testleri", certification.every((step) => step.status === "passed"), `${certification.filter((step) => step.status === "passed").length}/${certification.length} test geçti.`),
    check("reconciliation", "Canlı portföy mutabakatı", reconciliation?.status === "passed", reconciliation?.details ?? "Mutabakat henüz çalıştırılmadı."),
  ];
  return { chainId, ready: checks.every((item) => item.ready), checks };
}

function solanaReadiness(): IntegrationLiveReadiness {
  const credential = getStoredCredentialStatusSync("solana");
  const account = getExecutionAccount("solana");
  const risk = store.getRiskSettings();
  const reconciliation = store.listReconciliation().find((item) => item.integrationId === "solana");
  const certification = certificationStatus("solana");
  const feeLimit = getNetworkFeeLimit("solana", risk);
  const executionLimit = getNetworkExecutionLimit("solana", risk);
  const assetPolicy = risk.assetPolicy!;
  const checks = [
    check("kill_switch", "Canlı işlem anahtarı", enabled(process.env.LIVE_TRADING_ENABLED), "LIVE_TRADING_ENABLED=true olmalı."),
    check("rpc", "Helius RPC ve WebSocket", Boolean(readCredentialSync("solana-rpc-url")) && Boolean(readCredentialSync("solana-ws-url")), "SOLANA_RPC_URL ve SOLANA_WS_URL yapılandırılmalı."),
    check("helius", "Helius API", Boolean(readCredentialSync("helius-api-key")), "HELIUS_API_KEY keşif ve işlem çözümleme için gerekli."),
    check("wallet", "Solana shadow hesabı", Boolean(account), account ? `Public adres: ${account}` : "Shadow quote ve bakiye simülasyonu için Solana public adresi girilmeli."),
    check("signer", "macOS Keychain imzalayıcısı", credential.configured, credential.address ? `Yerel cüzdan: ${credential.address}` : "Canlı mod için Solana secret key macOS Keychain'e kaydedilmeli."),
    check("jupiter", "Jupiter spot yürütücüsü", Boolean(readCredentialSync("jupiter-api-key")), "JUPITER_API_KEY yapılandırılmalı."),
    check("risk_limits", "Canlı risk tavanları", executionLimit.maxTradeUsd > 0 && feeLimit.maxFeeUsd > 0 && feeLimit.maxFeePercent > 0, `İşlem ${executionLimit.maxTradeUsd.toFixed(2)} USD; toplam fee ${feeLimit.maxFeeUsd.toFixed(2)} USD ve %${feeLimit.maxFeePercent.toFixed(2)} ile sınırlı.`),
    check("asset_policy", "Varlık güvenlik politikası", assetPolicy.minimumSafetyScore > 0 && assetPolicy.requireVerifiedExitRoute, `Freeze authority ve genç piyasa satış rotası kontrol ediliyor; güvenlik skoru ${assetPolicy.minimumSafetyScore}.`),
    check("adapter", "Canlı Solana adaptörü", true, "Jupiter quote, versioned transaction, shadow simülasyonu ve Keychain imzası hazır."),
    executionSafetyCheck("solana"),
    check("certification", "Mikro canlı işlem testleri", certification.every((step) => step.status === "passed"), `${certification.filter((step) => step.status === "passed").length}/${certification.length} test geçti.`),
    check("reconciliation", "Canlı portföy mutabakatı", reconciliation?.status === "passed", reconciliation?.details ?? "Mutabakat henüz çalıştırılmadı."),
  ];
  return { chainId: "solana", ready: checks.every((item) => item.ready), checks };
}

function hyperliquidReadiness(): IntegrationLiveReadiness {
  const credential = getStoredCredentialStatusSync("hyperliquid-agent");
  const account = getExecutionAccount("hyperliquid");
  const risk = store.getRiskSettings();
  const reconciliation = store.listReconciliation().find((item) => item.integrationId === "hyperliquid");
  const certification = certificationStatus("hyperliquid");
  const feeLimit = getNetworkFeeLimit("hyperliquid", risk);
  const executionLimit = getNetworkExecutionLimit("hyperliquid", risk);
  const assetPolicy = risk.assetPolicy!;
  const checks = [
    check("kill_switch", "Canlı işlem anahtarı", enabled(process.env.LIVE_TRADING_ENABLED), "LIVE_TRADING_ENABLED=true olmalı."),
    check("account", "Hyperliquid shadow hesabı", Boolean(account), account ? `Public adres: ${account}` : "Shadow bakiye ve emir simülasyonu için Hyperliquid ana hesap adresi girilmeli."),
    check("signer", "macOS Keychain imzalayıcısı", credential.configured, credential.address ? `Agent cüzdan: ${credential.address}` : "Agent private key macOS Keychain hesabında tutulmalı."),
    check("exchange", "Exchange API", Boolean(readCredentialSync("hyperliquid-exchange-url") || "https://api.hyperliquid.xyz/exchange"), "HYPERLIQUID_EXCHANGE_URL yapılandırılmalı."),
    check("adapter", "Canlı HyperCore adaptörü", true, "İmzalı IOC emir, kaldıraç, reduce-only ve fill çözümleme adaptörü hazır."),
    check("risk_limits", "Canlı risk tavanları", executionLimit.maxTradeUsd > 0 && feeLimit.maxFeeUsd > 0 && feeLimit.maxFeePercent > 0, `İşlem ${executionLimit.minTradeUsd.toFixed(2)}–${executionLimit.maxTradeUsd.toFixed(2)} USD; toplam fee ${feeLimit.maxFeeUsd.toFixed(2)} USD ve %${feeLimit.maxFeePercent.toFixed(2)} ile sınırlı.`),
    check("asset_policy", "Varlık güvenlik politikası", assetPolicy.hypercoreMinVolume24hUsd > 0 && assetPolicy.hypercoreMinOpenInterestUsd > 0, `Minimum hacim ${assetPolicy.hypercoreMinVolume24hUsd.toFixed(0)} USD; perp açık pozisyon ${assetPolicy.hypercoreMinOpenInterestUsd.toFixed(0)} USD.`),
    check("copy_execution", "Canlı copy trade yönlendirmesi", true, "Spot/perp fill'leri kaynak-cüzdan execution lotlarıyla eşleniyor."),
    executionSafetyCheck("hyperliquid"),
    check("certification", "Mikro canlı işlem testleri", certification.every((step) => step.status === "passed"), `${certification.filter((step) => step.status === "passed").length}/${certification.length} test geçti.`),
    check("reconciliation", "Canlı portföy mutabakatı", reconciliation?.status === "passed", reconciliation?.details ?? "Mutabakat henüz çalıştırılmadı."),
  ];
  return { chainId: "hyperliquid", ready: checks.every((item) => item.ready), checks };
}

export function getLiveReadiness(): LiveReadiness {
  const integrations = INTEGRATION_IDS.map((chainId) => chainId === "hyperliquid"
    ? hyperliquidReadiness()
    : chainId === "solana" ? solanaReadiness() : evmReadiness(chainId));
  return {
    ready: integrations.filter((integration) => isLivePilotIntegration(integration.chainId)).every((integration) => integration.ready),
    integrations,
  };
}
