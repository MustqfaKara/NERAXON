import type { Address } from "viem";
import type { EvmChainId } from "@/lib/domain/types";
import type { TokenSafetyResult } from "@/lib/engine/token-security";
export { mergeTokenSafety } from "@/lib/engine/token-safety-merge";
import { getPublicClient } from "@/lib/chains/public-client";
import { evaluateHoneypotReport, type HoneypotSecurityReport } from "@/lib/security/honeypot-security";

const OWNER_ABI = [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const PAUSED_ABI = [{ type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] }] as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
const HONEYPOT_CACHE_TTL_MS = 10 * 60_000;
const honeypotCache = new Map<string, { result: Pick<TokenSafetyResult, "approved" | "warnings" | "checks">; expiresAt: number }>();

export async function inspectContractSecurity(chainId: EvmChainId, address: Address): Promise<Pick<TokenSafetyResult, "approved" | "warnings" | "checks">> {
  const client = getPublicClient(chainId);
  const checks: TokenSafetyResult["checks"] = [];
  const warnings: string[] = [];
  const code = await client.getCode({ address });
  const byteLength = Math.max(0, ((code?.length ?? 2) - 2) / 2);
  checks.push({ label: "Kontrat bytecode", status: byteLength > 100 ? "passed" : "warning", detail: `${byteLength.toLocaleString("tr-TR")} byte dağıtılmış kod.` });

  const owner = await client.readContract({ address, abi: OWNER_ABI, functionName: "owner" }).catch(() => null);
  if (owner) {
    const renounced = owner.toLowerCase() === ZERO_ADDRESS;
    checks.push({ label: "Kontrat sahipliği", status: renounced ? "passed" : "warning", detail: renounced ? "Sahiplik bırakılmış görünüyor." : `Aktif owner: ${owner.slice(0, 6)}…${owner.slice(-4)}` });
    if (!renounced) warnings.push("Kontrat sahipliği aktif; yönetici yetkileri ayrıca incelenmeli.");
  } else checks.push({ label: "Kontrat sahipliği", status: "warning", detail: "Standart owner() arayüzü bulunamadı." });

  const paused = await client.readContract({ address, abi: PAUSED_ABI, functionName: "paused" }).catch(() => null);
  if (paused === true) return { approved: false, warnings: [...warnings, "Kontrat pause durumunda."], checks: [...checks, { label: "Pause durumu", status: "failed", detail: "Kontrat paused=true döndürdü." }] };
  checks.push({ label: "Pause durumu", status: paused === false ? "passed" : "warning", detail: paused === false ? "Kontrat aktif." : "Standart paused() arayüzü bulunamadı." });

  const implementation = await client.getStorageAt({ address, slot: IMPLEMENTATION_SLOT }).catch(() => null);
  const isProxy = Boolean(implementation && BigInt(implementation) !== 0n);
  checks.push({ label: "Proxy yapısı", status: isProxy ? "warning" : "passed", detail: isProxy ? "Yükseltilebilir proxy işareti bulundu." : "EIP-1967 implementation işareti bulunmadı." });
  if (isProxy) warnings.push("Kontrat yükseltilebilir proxy kullanıyor.");
  if (chainId === "ethereum" || chainId === "base") {
    const honeypot = await inspectHoneypotSecurity(chainId, address);
    return {
      approved: honeypot.approved,
      warnings: [...warnings, ...honeypot.warnings],
      checks: [...checks, ...honeypot.checks],
    };
  }
  return { approved: true, warnings, checks };
}

async function inspectHoneypotSecurity(chainId: "ethereum" | "base", address: Address) {
  const cacheKey = `${chainId}:${address.toLowerCase()}`;
  const cached = honeypotCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const url = new URL("https://api.honeypot.is/v2/IsHoneypot");
  url.searchParams.set("address", address);
  url.searchParams.set("chainID", chainId === "ethereum" ? "1" : "8453");
  let result: Pick<TokenSafetyResult, "approved" | "warnings" | "checks">;
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    result = evaluateHoneypotReport(await response.json() as HoneypotSecurityReport);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Bilinmeyen servis hatası";
    result = {
      approved: false,
      warnings: ["Bağımsız token satış simülasyonu tamamlanamadı."],
      checks: [{ label: "Honeypot simülasyonu", status: "failed", detail: `Güvenlik servisi doğrulanamadı: ${detail}` }],
    };
  }
  honeypotCache.set(cacheKey, { result, expiresAt: Date.now() + HONEYPOT_CACHE_TTL_MS });
  return result;
}
