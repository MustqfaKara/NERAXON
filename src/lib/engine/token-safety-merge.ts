import type { TokenSafetyResult } from "./token-security.ts";

export interface TokenSafetySupplement {
  approved: boolean;
  warnings: string[];
  checks: TokenSafetyResult["checks"];
}

export function mergeTokenSafety(base: TokenSafetyResult, contract: TokenSafetySupplement): TokenSafetyResult {
  const warnings = [...base.warnings, ...contract.warnings];
  const checks = [...base.checks, ...contract.checks];
  const approved = base.approved && contract.approved;
  const score = approved ? Math.max(0, 100 - warnings.length * 10 - checks.filter((check) => check.status === "warning").length * 4) : 0;
  const contractFailure = contract.checks.find((check) => check.status === "failed")?.detail;
  const reason = approved
    ? warnings.join(" ") || "Piyasa ve kontrat kontrolleri geçti."
    : !base.approved
      ? base.reason
      : contractFailure || contract.warnings.join(" ") || "Kontrat güvenlik kontrolü reddedildi.";
  return { approved, warnings, checks, score, reason };
}
