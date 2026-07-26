import type { ChainId, ExecutionAttempt, TradingMode } from "@/lib/domain/types";
import type { ExecutionSubmissionHooks, NormalizedExecutionResult } from "@/lib/execution/execution-adapter";
import { createCertificationExecutionKey, createCopyExecutionKey, createManualExecutionKey, hypercoreClientOrderId } from "@/lib/engine/execution-idempotency";
import { store } from "@/lib/repositories/store";
import { isPreExecutionFilter, isTerminalExecutionRejection } from "@/lib/engine/execution-outcome";

export { createCertificationExecutionKey, createCopyExecutionKey, createManualExecutionKey, hypercoreClientOrderId };

export function claimExecutionAttempt(input: {
  requestId: string;
  idempotencyKey: string;
  integrationId: ChainId;
  walletId?: string | null;
  mode: Exclude<TradingMode, "paper">;
  source: "manual" | "copy" | "certification";
  action: string;
  asset: string;
  availableBalanceUsd?: number;
}) {
  return store.claimExecutionAttempt(input);
}

export async function runLiveSubmission<T extends NormalizedExecutionResult>(
  requestId: string,
  execute: (hooks: ExecutionSubmissionHooks) => Promise<T>,
): Promise<T> {
  const attempt = requireAttempt(requestId);
  if (attempt.mode !== "live") throw new Error("Canlı gönderim yaşam döngüsü yalnızca live modda kullanılabilir.");
  if (attempt.status !== "preparing") throw new Error(`Emir ${attempt.status} durumunda; yeniden gönderilemez.`);
  store.updateExecutionAttempt(requestId, { status: "submitting", reconciliationStatus: "pending" });
  const hooks: ExecutionSubmissionHooks = {
    idempotencyKey: attempt.idempotencyKey,
    async onSubmitted(reference) {
      store.updateExecutionAttempt(requestId, {
        status: "submitted",
        txHash: reference.txHash ?? null,
        externalOrderId: reference.externalOrderId ?? null,
        submittedAt: new Date().toISOString(),
        reconciliationStatus: "pending",
      });
    },
  };
  try {
    const result = await execute(hooks);
    const current = requireAttempt(requestId);
    if (current.status === "submitting") {
      await hooks.onSubmitted({ txHash: result.txHash, externalOrderId: result.externalOrderId });
    }
    return result;
  } catch (error) {
    recordExecutionFailure(requestId, error);
    throw error;
  }
}

export function recordExecutionFailure(requestId: string, error: unknown) {
  const attempt = store.getExecutionAttempt(requestId);
  if (!attempt) return;
  const message = error instanceof Error ? error.message : "Emir yürütme işlemi başarısız.";
  if (isTerminalExecutionRejection(message)) {
    store.updateExecutionAttempt(requestId, {
      status: "failed",
      errorMessage: message,
      reconciliationStatus: "passed",
      reconciliationDetails: "Borsa emri kesin olarak reddetti; fill oluşmadı.",
      reconciledAt: new Date().toISOString(),
    });
    return;
  }
  if (attempt.status === "submitted" || attempt.status === "confirmed") {
    store.updateExecutionAttempt(requestId, {
      status: attempt.status,
      errorMessage: message,
      reconciliationStatus: attempt.reconciliationStatus === "failed" ? "failed" : "pending",
    });
    return;
  }
  if (attempt.status === "submitting") {
    store.updateExecutionAttempt(requestId, {
      status: "stale",
      errorMessage: `Gönderim sonucu belirsiz: ${message}`,
      reconciliationStatus: "failed",
      reconciliationDetails: "Ağ referansı kaydedilmeden gönderim kesildi; otomatik tekrar engellendi.",
      reconciledAt: new Date().toISOString(),
    });
    return;
  }
  const filtered = isPreExecutionFilter(message);
  store.updateExecutionAttempt(requestId, {
    status: filtered ? "filtered" : "failed",
    errorMessage: message,
    reconciliationStatus: filtered ? "passed" : "pending",
    reconciliationDetails: filtered ? "Emir yürütme öncesinde filtrelendi; ağa veya borsaya gönderim yapılmadı." : null,
    reconciledAt: filtered ? new Date().toISOString() : null,
  });
}

function requireAttempt(requestId: string): ExecutionAttempt {
  const attempt = store.getExecutionAttempt(requestId);
  if (!attempt) throw new Error("Execution attempt bulunamadı.");
  return attempt;
}
