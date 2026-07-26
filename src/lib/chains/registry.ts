import type { ChainId } from "@/lib/domain/types";
import type { ChainAdapter } from "@/lib/chains/chain-adapter";
import { EvmChainAdapter } from "@/lib/chains/evm-chain-adapter";
import { HypercoreAdapter } from "@/lib/chains/hypercore-adapter";
import { SolanaAdapter } from "@/lib/chains/solana-adapter";

const adapters = new Map<ChainId, ChainAdapter>();

export function getChainAdapter(chainId: ChainId): ChainAdapter {
  let adapter = adapters.get(chainId);
  if (!adapter) {
    adapter = chainId === "hyperliquid"
      ? new HypercoreAdapter()
      : chainId === "solana"
        ? new SolanaAdapter()
        : new EvmChainAdapter(chainId);
    adapters.set(chainId, adapter);
  }
  return adapter;
}
