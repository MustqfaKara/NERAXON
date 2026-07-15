import type { ChainId } from "@/lib/domain/types";

export interface ChainHealth {
  blockNumber: number;
  latencyMs: number;
}

export interface ObservedTransaction {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  blockNumber: number;
  value: bigint;
}

export interface TransactionTokenMovement {
  tokenAddress: string;
  tokenSymbol: string;
  direction: "in" | "out";
  amount: number;
}

export interface TransactionInspection {
  targetAddress: string | null;
  selector: string;
  nativeValue: number;
  gasFeeNative: number;
  tokenMovements: TransactionTokenMovement[];
  likelyType: string;
}

export interface SwapObservation {
  txHash: string;
  side: "buy" | "sell";
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  tokenAmount: number;
  sourceAmount: number | null;
}

export interface ChainAdapter {
  readonly id: ChainId;
  checkHealth(): Promise<ChainHealth>;
  analyzeSwap(transaction: ObservedTransaction): Promise<SwapObservation | null>;
  inspectTransaction(transaction: ObservedTransaction): Promise<TransactionInspection>;
  startWatching(
    onBlock: (health: ChainHealth) => Promise<void>,
    onTransactions: (transactions: ObservedTransaction[]) => Promise<void>,
    trackedAddresses: () => Set<string>,
    onError: (error: Error) => Promise<void>,
  ): () => void;
}
