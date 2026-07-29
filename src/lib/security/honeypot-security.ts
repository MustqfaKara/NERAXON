import type { TokenSafetyResult } from "../engine/token-security.ts";

export interface HoneypotSecurityReport {
  summary?: {
    risk?: string;
    riskLevel?: number;
    flags?: Array<{ flag?: string; description?: string; severity?: string }>;
  };
  simulationSuccess?: boolean;
  simulationError?: string;
  honeypotResult?: { isHoneypot?: boolean; honeypotReason?: string };
  simulationResult?: { sellTax?: number };
  contractCode?: { rootOpenSource?: boolean };
}

export function evaluateHoneypotReport(report: HoneypotSecurityReport): Pick<TokenSafetyResult, "approved" | "warnings" | "checks"> {
  const riskLevel = Number(report.summary?.riskLevel ?? 0);
  const riskName = report.summary?.risk?.trim() || "unknown";
  const criticalFlag = report.summary?.flags?.find((flag) => ["critical", "high"].includes(flag.severity?.toLowerCase() ?? ""));
  const honeypot = report.honeypotResult?.isHoneypot === true;
  const simulationVerified = report.simulationSuccess === true && typeof report.honeypotResult?.isHoneypot === "boolean";
  const sellTax = Number(report.simulationResult?.sellTax ?? 0);
  const rejected = honeypot || riskLevel >= 60 || Boolean(criticalFlag) || !simulationVerified || sellTax > 20;
  const reason = honeypot
    ? report.honeypotResult?.honeypotReason || "Bağımsız simülasyon tokenı honeypot olarak işaretledi."
    : riskLevel >= 60
      ? `Bağımsız risk seviyesi ${riskLevel}/100 (${riskName}).`
      : criticalFlag
        ? criticalFlag.description || criticalFlag.flag || "Yüksek önem seviyeli güvenlik bayrağı bulundu."
        : !simulationVerified
          ? report.simulationError || "Token satış simülasyonu doğrulanamadı."
          : sellTax > 20
            ? `Satış vergisi %${sellTax.toFixed(2)} ile güvenlik sınırını aşıyor.`
            : `Alım ve satış simülasyonu geçti; risk ${riskLevel}/100.`;
  const warnings = report.contractCode?.rootOpenSource === false ? ["Token kök kontratının kaynak kodu doğrulanmamış."] : [];
  return {
    approved: !rejected,
    warnings,
    checks: [{
      label: "Honeypot simülasyonu",
      status: rejected ? "failed" : "passed",
      detail: reason,
    }],
  };
}
