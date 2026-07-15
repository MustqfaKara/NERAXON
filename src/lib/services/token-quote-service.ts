import { formatUnits, isAddress } from "viem";
import { getPublicClient } from "@/lib/chains/public-client";
import type { ChainId } from "@/lib/domain/types";
import { evaluateTokenSafety } from "@/lib/engine/token-security";
import { estimatePaperGas, type GasEstimate } from "@/lib/services/gas-estimator";
import { getMarketDataProvider, type MarketSnapshot } from "@/lib/services/market-data-provider";
import { inspectContractSecurity, mergeTokenSafety } from "@/lib/services/contract-security-service";

const ERC20_METADATA_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export interface TokenQuote {
  chainId: ChainId;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  market: MarketSnapshot;
  gas: GasEstimate;
  safety: {
    approved: boolean;
    warnings: string[];
    reason: string;
    score: number;
    checks: Array<{ label: string; status: "passed" | "warning" | "failed"; detail: string }>;
  };
  quotedAt: string;
}

export async function resolveTokenQuote(chainId: ChainId, tokenAddress: string): Promise<TokenQuote> {
  if (!isAddress(tokenAddress.toLowerCase())) throw new Error("Geçerli bir token kontrat adresi girin.");
  const address = tokenAddress.toLowerCase() as `0x${string}`;
  const client = getPublicClient(chainId);
  const code = await client.getCode({ address });
  if (!code || code === "0x") throw new Error("Bu adreste token kontratı bulunamadı.");

  const [name, symbol, decimals, totalSupply, market, gas] = await Promise.all([
    client.readContract({ address, abi: ERC20_METADATA_ABI, functionName: "name" }),
    client.readContract({ address, abi: ERC20_METADATA_ABI, functionName: "symbol" }),
    client.readContract({ address, abi: ERC20_METADATA_ABI, functionName: "decimals" }),
    client.readContract({ address, abi: ERC20_METADATA_ABI, functionName: "totalSupply" }),
    getMarketDataProvider().getTokenMarket(chainId, address),
    estimatePaperGas(chainId),
  ]);
  const marketWithCapitalization = {
    ...market,
    marketCapUsd: market.marketCapUsd ?? Number(formatUnits(totalSupply, decimals)) * market.priceUsd,
  };
  const safety = mergeTokenSafety(evaluateTokenSafety(marketWithCapitalization), await inspectContractSecurity(chainId, address));
  return {
    chainId,
    address,
    name,
    symbol,
    decimals,
    market: marketWithCapitalization,
    gas,
    safety,
    quotedAt: new Date().toISOString(),
  };
}
