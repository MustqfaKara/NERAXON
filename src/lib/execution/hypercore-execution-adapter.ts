import type { ExecutionAdapter, ExecutionSubmissionHooks, NormalizedExecutionResult } from "@/lib/execution/execution-adapter";
import { executeHypercorePlan, prepareHypercoreExecution, type HypercoreExecutionIntent, type HypercoreExecutionPlan } from "@/lib/execution/hypercore-live-execution";

class HypercoreExecutionAdapter implements ExecutionAdapter<HypercoreExecutionIntent, HypercoreExecutionPlan> {
  readonly integrationId = "hyperliquid" as const;

  prepare(intent: HypercoreExecutionIntent) {
    return prepareHypercoreExecution(intent);
  }

  async simulate(plan: HypercoreExecutionPlan) {
    return normalize(await executeHypercorePlan(plan, "shadow"));
  }

  async execute(plan: HypercoreExecutionPlan, hooks?: ExecutionSubmissionHooks) {
    return normalize(await executeHypercorePlan(plan, "live", hooks));
  }
}

export const hypercoreExecutionAdapter = new HypercoreExecutionAdapter();

function normalize(result: Awaited<ReturnType<typeof executeHypercorePlan>>): NormalizedExecutionResult {
  return {
    integrationId: "hyperliquid",
    mode: result.mode,
    status: result.mode === "shadow" ? "simulated" : result.status === "filled" ? "confirmed" : "resting",
    asset: `${result.plan.marketType}:${result.plan.coin}`.toLowerCase(),
    side: result.plan.side,
    requestedAmount: result.plan.size,
    executedAmount: result.mode === "shadow" ? result.plan.size : String(result.filledSize),
    receivedAmount: result.mode === "shadow" ? result.plan.size : String(result.receivedSize),
    txHash: null,
    externalOrderId: result.orderId === null ? null : String(result.orderId),
    averagePriceUsd: result.averagePriceUsd,
    executionFeeUsd: result.executionFeeUsd,
  };
}
