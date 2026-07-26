import { formatUnits, isAddress } from "viem";
import { getPublicClient } from "@/lib/chains/public-client";
import type { ChainId } from "@/lib/domain/types";
import { evaluateTokenSafety } from "@/lib/engine/token-security";
import { estimatePaperGas, type GasEstimate } from "@/lib/services/gas-estimator";
import { getMarketDataProvider, type MarketSnapshot } from "@/lib/services/market-data-provider";
import { inspectContractSecurity, mergeTokenSafety } from "@/lib/services/contract-security-service";
import { PublicKey } from "@solana/web3.js";
import { solanaRpc } from "@/lib/solana/helius-client";

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
  if (chainId === "solana") return resolveSolanaTokenQuote(tokenAddress);
  if (chainId === "hyperliquid") throw new Error("HyperCore piyasaları ayrı market uç noktasından alınır.");
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

interface SolanaAsset {
  content?: { metadata?: { name?: string; symbol?: string } };
  token_info?: { decimals?: number; supply?: number; token_program?: string; mint_authority?: string | null; freeze_authority?: string | null };
}

async function resolveSolanaTokenQuote(tokenAddress: string): Promise<TokenQuote> {
  let address: string;
  try { address = new PublicKey(tokenAddress.trim()).toBase58(); } catch { throw new Error("Geçerli bir Solana token mint adresi girin."); }
  const [asset, market, gas] = await Promise.all([
    solanaRpc<SolanaAsset>("getAsset", { id: address, displayOptions: { showFungible: true } }),
    getMarketDataProvider().getTokenMarket("solana", address),
    estimatePaperGas("solana"),
  ]);
  const decimals = asset.token_info?.decimals ?? 0;
  const supply = Number(asset.token_info?.supply ?? 0) / 10 ** decimals;
  const marketWithCapitalization = { ...market, marketCapUsd: market.marketCapUsd ?? (supply > 0 ? supply * market.priceUsd : null) };
  const baseSafety = evaluateTokenSafety(marketWithCapitalization);
  const solanaChecks = inspectSolanaAsset(asset);
  const safety = mergeTokenSafety(baseSafety, solanaChecks);
  return {
    chainId: "solana",
    address,
    name: asset.content?.metadata?.name?.trim() || market.tokenSymbol,
    symbol: asset.content?.metadata?.symbol?.trim() || market.tokenSymbol,
    decimals,
    market: marketWithCapitalization,
    gas,
    safety,
    quotedAt: new Date().toISOString(),
  };
}

export async function inspectSolanaTokenSecurity(tokenAddress: string) {
  const asset = await solanaRpc<SolanaAsset>("getAsset", { id: tokenAddress, displayOptions: { showFungible: true } });
  return inspectSolanaAsset(asset);
}

function inspectSolanaAsset(asset: SolanaAsset): Pick<TokenQuote["safety"], "approved" | "warnings" | "checks"> {
  const tokenInfo = asset.token_info;
  const checks: TokenQuote["safety"]["checks"] = [];
  const warnings: string[] = [];
  const supportedPrograms = new Set([
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ]);
  if (!tokenInfo?.token_program) return { approved: false, warnings: ["Solana token programı doğrulanamadı."], checks: [{ label: "Token programı", status: "failed", detail: "Helius token programı döndürmedi." }] };
  const knownProgram = supportedPrograms.has(tokenInfo.token_program);
  checks.push({ label: "Token programı", status: knownProgram ? "passed" : "failed", detail: knownProgram ? "Standart SPL token programı doğrulandı." : `Desteklenmeyen program: ${tokenInfo.token_program}` });
  if (!knownProgram) return { approved: false, warnings: ["Desteklenmeyen Solana token programı."], checks };
  if (tokenInfo.freeze_authority) return { approved: false, warnings: ["Solana freeze authority aktif."], checks: [...checks, { label: "Freeze authority", status: "failed", detail: "Token hesapları dondurulabilir." }] };
  checks.push({ label: "Freeze authority", status: "passed", detail: "Freeze authority bulunmuyor." });
  if (tokenInfo.mint_authority) {
    warnings.push("Solana mint authority aktif; arz artırılabilir.");
    checks.push({ label: "Mint authority", status: "warning", detail: "Token arzı artırılabilir." });
  } else checks.push({ label: "Mint authority", status: "passed", detail: "Mint authority bulunmuyor." });
  return { approved: true, warnings, checks };
}
