export interface SolanaShieldWarning {
  type: string;
  message: string;
  severity: string;
}

export interface SolanaSecurityChecks {
  approved: boolean;
  warnings: string[];
  checks: Array<{ label: string; status: "passed" | "warning" | "failed"; detail: string }>;
}

export function evaluateJupiterShieldWarnings(warnings: SolanaShieldWarning[]): SolanaSecurityChecks {
  const blockingTypes = new Set(["HAS_FREEZE_AUTHORITY", "MALICIOUS", "HONEYPOT", "BLOCKED", "HIGH_RISK"]);
  const materialWarningTypes = new Set(["HAS_MINT_AUTHORITY", ...blockingTypes]);
  const blocking = warnings.filter((warning) => blockingTypes.has(warning.type.toUpperCase()));
  const checks: SolanaSecurityChecks["checks"] = warnings.map((warning) => ({
    label: `Jupiter Shield · ${warning.type}`,
    status: blockingTypes.has(warning.type.toUpperCase()) ? "failed" : "warning",
    detail: warning.message,
  }));
  if (!warnings.length) {
    checks.push({ label: "Jupiter Shield", status: "passed", detail: "Jupiter zararlı mint uyarısı döndürmedi." });
  }
  return {
    approved: blocking.length === 0,
    warnings: warnings
      .filter((warning) => warning.severity !== "info" || materialWarningTypes.has(warning.type.toUpperCase()))
      .map((warning) => `Jupiter Shield: ${warning.message}`),
    checks,
  };
}
