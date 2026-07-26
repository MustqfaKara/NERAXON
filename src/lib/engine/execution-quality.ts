import type { ExecutionAttempt, ExecutionQuality, TradingMode } from "@/lib/domain/types";

export function calculateExecutionQuality(attempts: ExecutionAttempt[], mode: TradingMode): ExecutionQuality {
  if (mode === "paper") return emptyQuality();
  const copyAttempts = attempts.filter((attempt) => attempt.mode === mode && attempt.source === "copy");
  const filtered = copyAttempts.filter((attempt) => attempt.status === "filtered").length;
  const successful = copyAttempts.filter((attempt) => attempt.status === "simulated" || attempt.status === "confirmed").length;
  const failed = copyAttempts.filter((attempt) => attempt.status === "failed" || attempt.status === "stale").length;
  const executable = successful + failed;
  return {
    rawSignals: copyAttempts.length,
    filteredBeforeExecution: filtered,
    executableAttempts: executable,
    successfulExecutions: successful,
    failedExecutions: failed,
    successRate: executable ? Number((successful / executable * 100).toFixed(2)) : 0,
  };
}

function emptyQuality(): ExecutionQuality {
  return { rawSignals: 0, filteredBeforeExecution: 0, executableAttempts: 0, successfulExecutions: 0, failedExecutions: 0, successRate: 0 };
}
