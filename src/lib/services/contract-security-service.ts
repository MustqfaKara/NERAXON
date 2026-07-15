import type { Address } from "viem";
import type { ChainId } from "@/lib/domain/types";
import type { TokenSafetyResult } from "@/lib/engine/token-security";
import { getPublicClient } from "@/lib/chains/public-client";

const OWNER_ABI = [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const PAUSED_ABI = [{ type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] }] as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

export async function inspectContractSecurity(chainId: ChainId, address: Address): Promise<Pick<TokenSafetyResult, "approved" | "warnings" | "checks">> {
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
  return { approved: true, warnings, checks };
}

export function mergeTokenSafety(base: TokenSafetyResult, contract: Awaited<ReturnType<typeof inspectContractSecurity>>): TokenSafetyResult {
  const warnings = [...base.warnings, ...contract.warnings];
  const checks = [...base.checks, ...contract.checks];
  const approved = base.approved && contract.approved;
  const score = approved ? Math.max(0, 100 - warnings.length * 10 - checks.filter((check) => check.status === "warning").length * 4) : 0;
  return { approved, warnings, checks, score, reason: approved ? warnings.join(" ") || "Piyasa ve kontrat kontrolleri geçti." : warnings.join(" ") || "Kontrat güvenlik kontrolü reddedildi." };
}
