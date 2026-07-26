import { createPublicClient } from "viem";
import type { EvmChainId } from "@/lib/domain/types";
import { createEvmFallbackTransport } from "@/lib/chains/evm-rpc-pool";

function createRpcClient(chainId: EvmChainId) {
  return createPublicClient({
    transport: createEvmFallbackTransport(chainId),
  });
}

type RpcClient = ReturnType<typeof createRpcClient>;
const clients = new Map<EvmChainId, RpcClient>();

export function getPublicClient(chainId: EvmChainId): RpcClient {
  const existing = clients.get(chainId);
  if (existing) return existing;
  const client = createRpcClient(chainId);
  clients.set(chainId, client);
  return client;
}
