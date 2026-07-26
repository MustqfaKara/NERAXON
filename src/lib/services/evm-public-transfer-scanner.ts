import { formatUnits, type Address } from "viem";
import type { EvmChainId } from "@/lib/domain/types";
import { fetchEvmRpcJson } from "@/lib/chains/evm-rpc-pool";
import { getPublicClient } from "@/lib/chains/public-client";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DECIMALS_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;
const MAX_LOGS = 100_000;

interface RpcLog {
  address: string;
  blockNumber: string;
  blockTimestamp?: string;
  transactionHash: string;
  topics: string[];
  data: string;
}

export interface PublicErc20Transfer {
  hash: string;
  from: string;
  to: string;
  tokenAddress: string;
  value: number;
  timestamp: string;
}

export async function scanPublicErc20Transfers(
  chainId: EvmChainId,
  fromBlock: bigint,
  toBlock: bigint,
  tokenAddresses: string[],
): Promise<PublicErc20Transfer[]> {
  if (!tokenAddresses.length || fromBlock > toBlock) return [];
  const addresses = [...new Set(tokenAddresses.map((address) => address.toLowerCase()))];
  const decimals = await readTokenDecimals(chainId, addresses);
  const logs = await collectLogs(chainId, fromBlock, toBlock, addresses);
  const span = toBlock > fromBlock ? Number(toBlock - fromBlock) : 1;
  const now = Date.now();

  return logs.flatMap((log) => {
    if (log.topics.length < 3 || !log.transactionHash) return [];
    const tokenAddress = log.address.toLowerCase();
    const tokenDecimals = decimals.get(tokenAddress);
    if (tokenDecimals === undefined) return [];
    const blockNumber = BigInt(log.blockNumber);
    const ageFraction = Math.min(1, Math.max(0, Number(toBlock - blockNumber) / span));
    const value = Number(formatUnits(BigInt(log.data || "0x0"), tokenDecimals));
    if (!Number.isFinite(value) || value <= 0) return [];
    return [{
      hash: log.transactionHash.toLowerCase(),
      from: topicAddress(log.topics[1]),
      to: topicAddress(log.topics[2]),
      tokenAddress,
      value,
      timestamp: log.blockTimestamp
        ? new Date(Number(BigInt(log.blockTimestamp)) * 1_000).toISOString()
        : new Date(now - ageFraction * 86_400_000).toISOString(),
    }];
  });
}

async function collectLogs(
  chainId: EvmChainId,
  fromBlock: bigint,
  toBlock: bigint,
  addresses: string[],
): Promise<RpcLog[]> {
  const initialChunk = chainId === "robinhood" ? 5_000n : 1_000n;
  const addressChunkSize = chainId === "robinhood" ? 5 : 2;
  const logs: RpcLog[] = [];
  for (let addressIndex = 0; addressIndex < addresses.length && logs.length < MAX_LOGS; addressIndex += addressChunkSize) {
    const addressChunk = addresses.slice(addressIndex, addressIndex + addressChunkSize);
    for (let cursor = fromBlock; cursor <= toBlock && logs.length < MAX_LOGS; cursor += initialChunk) {
      const end = cursor + initialChunk - 1n > toBlock ? toBlock : cursor + initialChunk - 1n;
      logs.push(...await fetchRangeAdaptive(chainId, cursor, end, addressChunk));
    }
  }
  return logs.slice(0, MAX_LOGS);
}

async function fetchRangeAdaptive(
  chainId: EvmChainId,
  fromBlock: bigint,
  toBlock: bigint,
  addresses: string[],
): Promise<RpcLog[]> {
  try {
    const payload = await fetchEvmRpcJson<{ result?: RpcLog[] }>(
      chainId,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getLogs",
        params: [{
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: `0x${toBlock.toString(16)}`,
          address: addresses,
          topics: [TRANSFER_TOPIC],
        }],
      },
      30_000,
    );
    return payload.result ?? [];
  } catch (error) {
    if (fromBlock >= toBlock) throw error;
    const middle = (fromBlock + toBlock) / 2n;
    const [left, right] = await Promise.all([
      fetchRangeAdaptive(chainId, fromBlock, middle, addresses),
      fetchRangeAdaptive(chainId, middle + 1n, toBlock, addresses),
    ]);
    return [...left, ...right];
  }
}

async function readTokenDecimals(chainId: EvmChainId, addresses: string[]) {
  const client = getPublicClient(chainId);
  const entries = await Promise.all(addresses.map(async (address) => {
    try {
      const value = await client.readContract({
        address: address as Address,
        abi: DECIMALS_ABI,
        functionName: "decimals",
      });
      return [address, Number(value)] as const;
    } catch {
      return null;
    }
  }));
  return new Map(entries.filter((entry): entry is readonly [string, number] => Boolean(entry)));
}

function topicAddress(topic: string | undefined) {
  return topic ? `0x${topic.slice(-40)}`.toLowerCase() : "";
}
