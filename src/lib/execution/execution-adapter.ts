import type { ChainId, TradingMode } from "@/lib/domain/types";

export interface NormalizedExecutionResult {
  integrationId: ChainId;
  mode: Exclude<TradingMode, "paper">;
  status: "simulated" | "confirmed" | "resting";
  asset: string;
  side: "buy" | "sell";
  requestedAmount: string;
  executedAmount: string;
  receivedAmount: string;
  txHash: string | null;
  externalOrderId: string | null;
  averagePriceUsd?: number | null;
  executionFeeUsd?: number | null;
  networkFeeNativeAmount?: string;
  refundableRentNativeAmount?: string;
}

export interface ExecutionSubmissionHooks {
  idempotencyKey: string;
  onSubmitted(reference: { txHash?: string | null; externalOrderId?: string | null }): void | Promise<void>;
}

export interface ExecutionAdapter<TIntent, TPlan> {
  readonly integrationId: ChainId;
  prepare(intent: TIntent): Promise<TPlan>;
  simulate(plan: TPlan): Promise<NormalizedExecutionResult>;
  execute(plan: TPlan, hooks?: ExecutionSubmissionHooks): Promise<NormalizedExecutionResult>;
}
