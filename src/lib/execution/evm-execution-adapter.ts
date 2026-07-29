import type { Address } from "viem";
import type { EvmChainId, TradeSide, TradingMode } from "@/lib/domain/types";
import type { ExecutionAdapter, ExecutionSubmissionHooks, NormalizedExecutionResult } from "@/lib/execution/execution-adapter";
import { executeEvmQuote, prepareEvmExecution, type EvmExecutionQuote } from "@/lib/execution/evm-live-execution";
import { executeRobinhoodQuote, prepareRobinhoodExecution, type RobinhoodExecutionQuote } from "@/lib/execution/robinhood-v4-execution";

export interface EvmAdapterIntent {
  chainId: EvmChainId;
  side: TradeSide;
  tokenAddress: Address;
  preferredPairAddress?: Address;
  preferredVenue?: "amm" | "robinhood-portal";
  referencePriceUsd?: number;
  tokenDecimals?: number;
  portalExitRouteVerified?: boolean;
  allocationPercent?: number;
  sellPercent?: number;
  exactSellAmount?: bigint;
  slippagePercent: number;
  mode: Exclude<TradingMode, "paper">;
}

export type EvmAdapterPlan = EvmExecutionQuote | RobinhoodExecutionQuote;

class ZeroExExecutionAdapter implements ExecutionAdapter<EvmAdapterIntent, EvmExecutionQuote> {
  constructor(readonly integrationId: "ethereum" | "base") {}

  prepare(intent: EvmAdapterIntent) {
    return prepareEvmExecution({ ...intent, chainId: this.integrationId });
  }

  async simulate(plan: EvmExecutionQuote) {
    return normalizeZeroEx(await executeEvmQuote(plan, "shadow"));
  }

  async execute(plan: EvmExecutionQuote, hooks?: ExecutionSubmissionHooks) {
    return normalizeZeroEx(await executeEvmQuote(plan, "live", hooks));
  }
}

class RobinhoodExecutionAdapter implements ExecutionAdapter<EvmAdapterIntent, RobinhoodExecutionQuote> {
  readonly integrationId = "robinhood" as const;

  prepare(intent: EvmAdapterIntent) {
    return prepareRobinhoodExecution(intent);
  }

  async simulate(plan: RobinhoodExecutionQuote) {
    return normalizeRobinhood(await executeRobinhoodQuote(plan, "shadow"));
  }

  async execute(plan: RobinhoodExecutionQuote, hooks?: ExecutionSubmissionHooks) {
    return normalizeRobinhood(await executeRobinhoodQuote(plan, "live", hooks));
  }
}

const adapters: Record<EvmChainId, ExecutionAdapter<EvmAdapterIntent, EvmAdapterPlan>> = {
  ethereum: new ZeroExExecutionAdapter("ethereum") as ExecutionAdapter<EvmAdapterIntent, EvmAdapterPlan>,
  base: new ZeroExExecutionAdapter("base") as ExecutionAdapter<EvmAdapterIntent, EvmAdapterPlan>,
  robinhood: new RobinhoodExecutionAdapter() as ExecutionAdapter<EvmAdapterIntent, EvmAdapterPlan>,
};

export function getEvmExecutionAdapter(chainId: EvmChainId) {
  return adapters[chainId];
}

function normalizeZeroEx(result: Awaited<ReturnType<typeof executeEvmQuote>>): NormalizedExecutionResult {
  return {
    integrationId: result.quote.chainId,
    mode: result.mode,
    status: result.mode === "shadow" ? "simulated" : "confirmed",
    asset: result.quote.side === "buy" ? result.quote.buyToken : result.quote.sellToken,
    side: result.quote.side,
    requestedAmount: result.quote.sellAmount.toString(),
    executedAmount: result.actualSellAmount.toString(),
    receivedAmount: result.actualBuyAmount.toString(),
    txHash: result.txHash,
    externalOrderId: null,
    networkFeeNativeAmount: result.mode === "live" ? result.networkFeeNativeAmount.toString() : undefined,
  };
}

function normalizeRobinhood(result: Awaited<ReturnType<typeof executeRobinhoodQuote>>): NormalizedExecutionResult {
  return {
    integrationId: "robinhood",
    mode: result.mode,
    status: result.mode === "shadow" ? "simulated" : "confirmed",
    asset: result.quote.tokenAddress,
    side: result.quote.side,
    requestedAmount: result.quote.sellAmount.toString(),
    executedAmount: result.actualSellAmount.toString(),
    receivedAmount: result.actualBuyAmount.toString(),
    txHash: result.txHash,
    externalOrderId: null,
    networkFeeNativeAmount: result.mode === "live" ? result.networkFeeNativeAmount.toString() : undefined,
  };
}
