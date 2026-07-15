import { createPublicClient, http } from "viem";
import { CHAIN_DEFINITIONS } from "@/lib/domain/defaults";
import type { ChainId } from "@/lib/domain/types";

function createRpcClient(chainId: ChainId) {
  return createPublicClient({
    transport: http(CHAIN_DEFINITIONS[chainId].rpcUrl, { timeout: 10_000 }),
  });
}

type RpcClient = ReturnType<typeof createRpcClient>;
const clients = new Map<ChainId, RpcClient>();

export function getPublicClient(chainId: ChainId): RpcClient {
  const existing = clients.get(chainId);
  if (existing) return existing;
  const client = createRpcClient(chainId);
  clients.set(chainId, client);
  return client;
}
