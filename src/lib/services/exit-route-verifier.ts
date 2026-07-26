import type { EvmAdapterPlan } from "@/lib/execution/evm-execution-adapter";
import { verifyRobinhoodSellRoute } from "@/lib/execution/robinhood-v4-execution";
import type { SolanaExecutionPlan } from "@/lib/execution/solana-execution-adapter";
import { SOLANA_NATIVE_MINT } from "@/lib/solana/constants";
import { getJupiterQuote } from "@/lib/services/jupiter-api";
import { readCredentialSync } from "@/lib/security/credential-vault";

const CACHE_TTL_MS = 5 * 60_000;
const routeCache = new Map<string, { verified: boolean; expiresAt: number }>();

export async function verifyEvmExitRoute(plan: EvmAdapterPlan) {
  if (plan.side !== "buy") return true;
  const tokenAddress = "tokenAddress" in plan ? plan.tokenAddress : plan.buyToken;
  const cacheKey = `${plan.chainId}:${tokenAddress.toLowerCase()}`;
  return cachedVerification(cacheKey, async () => {
    if (plan.chainId === "robinhood" && "poolKey" in plan) return verifyRobinhoodSellRoute(plan);
    if (plan.chainId === "robinhood") return false;
    const apiKey = readCredentialSync("zerox-api-key");
    if (!apiKey) return verifyLifiExitRoute(plan.chainId, tokenAddress, plan.buyAmount, plan.account);
    const chainId = plan.chainId === "ethereum" ? 1 : 8453;
    const baseUrl = process.env[`${plan.chainId.toUpperCase()}_SWAP_API_URL`]?.trim() || "https://api.0x.org";
    const url = new URL("/swap/allowance-holder/price", baseUrl);
    url.searchParams.set("chainId", String(chainId));
    url.searchParams.set("sellToken", tokenAddress);
    url.searchParams.set("buyToken", "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    url.searchParams.set("sellAmount", plan.buyAmount.toString());
    url.searchParams.set("taker", plan.account);
    const response = await fetch(url, { headers: { "0x-api-key": apiKey, "0x-version": "v2" }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return verifyLifiExitRoute(plan.chainId, tokenAddress, plan.buyAmount, plan.account);
    const payload = await response.json() as { liquidityAvailable?: boolean; buyAmount?: string };
    if (payload.liquidityAvailable !== false && BigInt(payload.buyAmount ?? 0) > 0n) return true;
    return verifyLifiExitRoute(plan.chainId, tokenAddress, plan.buyAmount, plan.account);
  });
}

async function verifyLifiExitRoute(chainId: "ethereum" | "base", tokenAddress: string, amount: bigint, account: string) {
  const numericChainId = chainId === "ethereum" ? 1 : 8453;
  const url = new URL("https://li.quest/v1/quote");
  url.searchParams.set("fromChain", String(numericChainId));
  url.searchParams.set("toChain", String(numericChainId));
  url.searchParams.set("fromToken", tokenAddress);
  url.searchParams.set("toToken", "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  url.searchParams.set("fromAmount", amount.toString());
  url.searchParams.set("fromAddress", account);
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return false;
  const payload = await response.json() as { estimate?: { toAmount?: string }; transactionRequest?: { to?: string; data?: string } };
  return BigInt(payload.estimate?.toAmount ?? 0) > 0n && Boolean(payload.transactionRequest?.to && payload.transactionRequest.data);
}

export async function verifySolanaExitRoute(plan: SolanaExecutionPlan) {
  if (plan.side !== "buy") return true;
  const cacheKey = `solana:${plan.tokenAddress}`;
  return cachedVerification(cacheKey, async () => {
    const quote = await getJupiterQuote({
      inputMint: plan.tokenAddress,
      outputMint: SOLANA_NATIVE_MINT,
      amount: BigInt(plan.quote.outAmount),
      slippageBps: plan.quote.slippageBps,
    });
    return BigInt(quote.outAmount) > 0n && quote.routePlan.length > 0;
  });
}

async function cachedVerification(cacheKey: string, verifier: () => Promise<boolean>) {
  const cached = routeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.verified;
  const verified = await verifier().catch(() => false);
  routeCache.set(cacheKey, { verified, expiresAt: Date.now() + CACHE_TTL_MS });
  return verified;
}
