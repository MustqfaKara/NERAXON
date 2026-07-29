import {
  createWalletClient,
  concatHex,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  getAddress,
  isAddress,
  numberToHex,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_DEFINITIONS } from "@/lib/domain/defaults";
import type { EvmChainId, TradeSide, TradingMode } from "@/lib/domain/types";
import { getPublicClient } from "@/lib/chains/public-client";
import { createEvmFallbackTransport, getEvmRpcUrls } from "@/lib/chains/evm-rpc-pool";
import { readPrivateKey } from "@/lib/security/keychain";
import { readCredentialSync } from "@/lib/security/credential-vault";
import { calculateNativeBuyAmount, calculateTokenSellAmount } from "@/lib/execution/evm-execution-math";
import { assertLiveExecutionEnabled } from "@/lib/execution/live-execution-switch";
import { getExecutionAccount } from "@/lib/services/execution-account-service";
import { store } from "@/lib/repositories/store";
import { assertAssetNotDenied } from "@/lib/engine/asset-execution-policy";
import type { ExecutionSubmissionHooks } from "@/lib/execution/execution-adapter";
import { monitorService, recordServiceHealth } from "@/lib/services/service-health";
import {
  assertExecutionContractPolicy,
  assertTrustedExecutionApi,
  BASE_UNISWAP_V2_FACTORY,
  BASE_UNISWAP_V2_ROUTER,
  BASE_UNISWAP_V3_FACTORY,
  BASE_UNISWAP_V3_QUOTER,
  BASE_UNISWAP_V3_ROUTER,
  BASE_WETH,
  isLifiRouteUnavailable,
  isZeroExRouteUnavailable,
  validateLifiQuotePayload,
  type LifiQuoteResponse,
} from "@/lib/execution/evm-route-validation";

const NATIVE_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address;
const SUPPORTED_0X_CHAINS = new Set<EvmChainId>(["ethereum", "base"]);
const CHAIN_NUMBERS: Record<EvmChainId, number> = { ethereum: 1, base: 8453, robinhood: 4663 };
const ERC20_BALANCE_ABI = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);
const UNISWAP_V2_FACTORY_ABI = parseAbi(["function getPair(address tokenA, address tokenB) view returns (address pair)"]);
const UNISWAP_V2_PAIR_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
]);
const UNISWAP_V2_ROUTER_ABI = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);
const UNISWAP_V3_FACTORY_ABI = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"]);
const UNISWAP_V3_POOL_ABI = parseAbi([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
]);
const UNISWAP_V3_QUOTER_ABI = parseAbi([
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);
const UNISWAP_V3_ROUTER_ABI = parseAbi([
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
]);
const UNISWAP_V3_FEE_TIERS = [100, 500, 3_000, 10_000] as const;

export interface EvmExecutionIntent {
  chainId: EvmChainId;
  side: TradeSide;
  tokenAddress: Address;
  preferredPairAddress?: Address;
  allocationPercent?: number;
  sellPercent?: number;
  exactSellAmount?: bigint;
  slippagePercent: number;
  mode: Exclude<TradingMode, "paper">;
}

export interface EvmExecutionQuote {
  provider: "0x" | "lifi" | "uniswap-v2" | "uniswap-v3";
  routeTool: string | null;
  providerFeeUsd: number;
  chainId: EvmChainId;
  side: TradeSide;
  account: Address;
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  buyAmount: bigint;
  minBuyAmount: bigint;
  allowanceSpender: Address | null;
  transaction: { to: Address; data: Hex; value: bigint; gas: bigint | null; gasPrice: bigint | null };
  quotedAt: string;
}

export interface EvmExecutionResult {
  mode: "shadow" | "live";
  quote: EvmExecutionQuote;
  approvalTxHash: Hex | null;
  txHash: Hex | null;
  blockNumber: bigint | null;
  gasUsed: bigint | null;
  networkFeeNativeAmount: bigint;
  actualSellAmount: bigint;
  actualBuyAmount: bigint;
}

interface ZeroExQuoteResponse {
  buyAmount?: string;
  minBuyAmount?: string;
  sellAmount?: string;
  liquidityAvailable?: boolean;
  issues?: { allowance?: { spender?: string } | null };
  transaction?: { to?: string; data?: string; value?: string; gas?: string; gasPrice?: string };
}

interface ZeroExErrorResponse {
  code?: string;
  reason?: string;
  message?: string;
  validationErrors?: Array<{
    field?: string;
    code?: string;
    reason?: string;
    description?: string;
  }>;
}

export function isZeroExLiveSupported(chainId: EvmChainId) {
  return SUPPORTED_0X_CHAINS.has(chainId);
}

export async function prepareEvmExecution(intent: EvmExecutionIntent): Promise<EvmExecutionQuote> {
  if (!isZeroExLiveSupported(intent.chainId)) throw new Error(`${CHAIN_DEFINITIONS[intent.chainId].name} için canlı swap adaptörü henüz hazır değil.`);
  if (!isAddress(intent.tokenAddress)) throw new Error("Geçerli token kontrat adresi gerekli.");
  const accountAddress = intent.mode === "shadow"
    ? getExecutionAccount("evm")
    : privateKeyToAccount(await readPrivateKey("evm")).address;
  if (!accountAddress || !isAddress(accountAddress)) throw new Error("EVM işlem hesabı yapılandırılmadı.");
  const accountAddressNormalized = getAddress(accountAddress);
  const publicClient = getPublicClient(intent.chainId);
  const sellToken = intent.side === "buy" ? NATIVE_TOKEN : getAddress(intent.tokenAddress);
  const buyToken = intent.side === "buy" ? getAddress(intent.tokenAddress) : NATIVE_TOKEN;
  const shadowAccount = intent.mode === "shadow" ? store.getShadowAccount(intent.chainId) : null;
  const balance = intent.side === "buy"
    ? shadowAccount
      ? parseUnits(shadowAccount.fundingTokenAmount.toFixed(18), 18)
      : await publicClient.getBalance({ address: accountAddressNormalized })
    : intent.mode === "shadow" && intent.exactSellAmount !== undefined
      ? intent.exactSellAmount
      : await publicClient.readContract({ address: getAddress(intent.tokenAddress), abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [accountAddressNormalized] });
  const sellAmount = intent.side === "buy"
    ? calculateNativeBuyAmount(balance, intent.allocationPercent ?? 7.5)
    : intent.exactSellAmount === undefined
      ? calculateTokenSellAmount(balance, intent.sellPercent ?? 100)
      : intent.exactSellAmount > balance ? balance : intent.exactSellAmount;
  if (sellAmount <= 0n) throw new Error(intent.side === "buy" ? `Gas rezervi sonrasında kullanılabilir ETH yok. Bakiye: ${formatEther(balance)} ETH.` : "Satılabilecek token bakiyesi yok.");

  try {
    const quote = await requestZeroExQuote(intent, accountAddressNormalized, sellToken, buyToken, sellAmount);
    await validateBuyExecution(quote);
    return quote;
  } catch (error) {
    if (intent.chainId !== "base" || !isZeroExRouteUnavailable(error)) throw error;
    try {
      const quote = await requestLifiQuote(intent, accountAddressNormalized, sellToken, buyToken, sellAmount);
      await validateBuyExecution(quote);
      return quote;
    } catch (lifiError) {
      if (!isLifiRouteUnavailable(lifiError)) throw lifiError;
      if (intent.side === "buy") {
        const quote = await requestBaseUniswapV3BuyQuote(intent, accountAddressNormalized, sellToken, buyToken, sellAmount);
        await validateBuyExecution(quote);
        return quote;
      }
      return requestBaseUniswapV2SellQuote(intent, accountAddressNormalized, sellToken, buyToken, sellAmount);
    }
  }
}

async function validateBuyExecution(quote: EvmExecutionQuote) {
  if (quote.side !== "buy") return;
  try {
    await getPublicClient(quote.chainId).call({
      account: quote.account,
      to: quote.transaction.to,
      data: quote.transaction.data,
      value: quote.transaction.value,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bilinmeyen simülasyon hatası.";
    throw new Error(`${quote.provider} rota simülasyonu başarısız: ${message}`);
  }
}

async function requestZeroExQuote(intent: EvmExecutionIntent, account: Address, sellToken: Address, buyToken: Address, sellAmount: bigint) {
  const apiKey = readCredentialSync("zerox-api-key");
  if (!apiKey) throw new Error("0x API anahtarı yapılandırılmadı.");
  const baseUrl = process.env[`${intent.chainId.toUpperCase()}_SWAP_API_URL`]?.trim() || "https://api.0x.org";
  assertTrustedExecutionApi("0x", baseUrl);
  const url = new URL("/swap/allowance-holder/quote", baseUrl);
  url.searchParams.set("chainId", String(CHAIN_NUMBERS[intent.chainId]));
  url.searchParams.set("sellToken", sellToken);
  url.searchParams.set("buyToken", buyToken);
  url.searchParams.set("sellAmount", sellAmount.toString());
  url.searchParams.set("taker", account);
  url.searchParams.set("slippageBps", String(Math.round(intent.slippagePercent * 100)));
  const result = await monitorService("zeroex", async () => {
    const response = await fetch(url, {
      headers: { "0x-api-key": apiKey, "0x-version": "v2" },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    const payload = await readZeroExPayload(response);
    return { response, payload };
  });
  if (!result.response.ok) {
    const error = new Error(`0x quote alınamadı (${result.response.status}): ${describeZeroExError(result.payload)}`);
    if (!isZeroExRouteUnavailable(error)) recordServiceHealth("zeroex", 0, error.message);
    throw error;
  }
  return validateZeroExQuote(intent, account, sellToken, buyToken, sellAmount, result.payload);
}

async function readZeroExPayload(response: Response): Promise<ZeroExQuoteResponse & ZeroExErrorResponse> {
  const body = await response.text();
  if (!body.trim()) return {};
  try {
    return JSON.parse(body) as ZeroExQuoteResponse & ZeroExErrorResponse;
  } catch {
    return { message: body.trim().slice(0, 500) };
  }
}

function describeZeroExError(payload: ZeroExErrorResponse) {
  const headline = [payload.code, payload.reason, payload.message]
    .find((value) => typeof value === "string" && value.trim())
    ?.trim() ?? "Bilinmeyen hata";
  const details = (payload.validationErrors ?? [])
    .map((entry) => {
      const reason = entry.reason?.trim() || entry.description?.trim() || entry.code?.trim();
      if (!reason) return null;
      return entry.field?.trim() ? `${entry.field}: ${reason}` : reason;
    })
    .filter((value): value is string => Boolean(value));
  return details.length ? `${headline} · ${details.join(" · ")}` : headline;
}

async function requestLifiQuote(intent: EvmExecutionIntent, account: Address, sellToken: Address, buyToken: Address, sellAmount: bigint) {
  const baseUrl = process.env.LIFI_API_URL?.trim() || "https://li.quest";
  assertTrustedExecutionApi("lifi", baseUrl);
  const url = new URL("/v1/quote", baseUrl);
  const chainNumber = CHAIN_NUMBERS[intent.chainId];
  url.searchParams.set("fromChain", String(chainNumber));
  url.searchParams.set("toChain", String(chainNumber));
  url.searchParams.set("fromToken", sellToken);
  url.searchParams.set("toToken", buyToken);
  url.searchParams.set("fromAmount", sellAmount.toString());
  url.searchParams.set("fromAddress", account);
  url.searchParams.set("toAddress", account);
  url.searchParams.set("slippage", String(intent.slippagePercent / 100));
  url.searchParams.set("integrator", "neraxon");
  const apiKey = readCredentialSync("lifi-api-key");
  return monitorService("lifi", async () => {
    const response = await fetch(url, {
      headers: apiKey ? { "x-lifi-api-key": apiKey } : undefined,
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    const payload = await response.json() as LifiQuoteResponse & { message?: string; errors?: string };
    if (!response.ok) throw new Error(`LI.FI quote alınamadı (${response.status}): ${payload.message ?? payload.errors ?? "Bilinmeyen hata"}`);
    return validateLifiQuote(intent, account, sellToken, buyToken, sellAmount, payload);
  });
}

async function requestBaseUniswapV2SellQuote(
  intent: EvmExecutionIntent,
  account: Address,
  sellToken: Address,
  buyToken: Address,
  sellAmount: bigint,
): Promise<EvmExecutionQuote> {
  if (intent.chainId !== "base" || intent.side !== "sell" || getAddress(buyToken) !== getAddress(NATIVE_TOKEN)) {
    throw new Error("Doğrudan Uniswap V2 fallback yalnızca Base token satışlarında kullanılabilir.");
  }
  const publicClient = getPublicClient("base");
  const pair = getAddress(await publicClient.readContract({
    address: BASE_UNISWAP_V2_FACTORY,
    abi: UNISWAP_V2_FACTORY_ABI,
    functionName: "getPair",
    args: [sellToken, BASE_WETH],
  }));
  if (pair === "0x0000000000000000000000000000000000000000") {
    throw new Error("Token için resmî Base Uniswap V2 token/WETH havuzu bulunamadı.");
  }
  const [token0, token1, reserves, amounts] = await Promise.all([
    publicClient.readContract({ address: pair, abi: UNISWAP_V2_PAIR_ABI, functionName: "token0" }),
    publicClient.readContract({ address: pair, abi: UNISWAP_V2_PAIR_ABI, functionName: "token1" }),
    publicClient.readContract({ address: pair, abi: UNISWAP_V2_PAIR_ABI, functionName: "getReserves" }),
    publicClient.readContract({
      address: BASE_UNISWAP_V2_ROUTER,
      abi: UNISWAP_V2_ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [sellAmount, [sellToken, BASE_WETH]],
    }),
  ]);
  const pairTokens = new Set([getAddress(token0), getAddress(token1)]);
  if (!pairTokens.has(getAddress(sellToken)) || !pairTokens.has(BASE_WETH) || reserves[0] <= 0n || reserves[1] <= 0n) {
    throw new Error("Uniswap V2 havuz tokenleri veya rezervleri doğrulanamadı.");
  }
  const buyAmount = amounts[1] ?? 0n;
  const slippageBps = BigInt(Math.max(1, Math.min(9_900, Math.round(intent.slippagePercent * 100))));
  const minBuyAmount = buyAmount * (10_000n - slippageBps) / 10_000n;
  if (buyAmount <= 0n || minBuyAmount <= 0n || minBuyAmount > buyAmount) {
    throw new Error("Uniswap V2 çıkış miktarı güvenlik doğrulamasından geçmedi.");
  }
  try {
    await publicClient.call({
      account,
      to: sellToken,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [pair, sellAmount] }),
    });
  } catch {
    throw new Error("Token kontratı Uniswap havuzuna doğrudan transferi reddetti; token satışı kontrat seviyesinde kısıtlı olabilir.");
  }
  const transaction = {
    to: BASE_UNISWAP_V2_ROUTER,
    data: encodeFunctionData({
      abi: UNISWAP_V2_ROUTER_ABI,
      functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens",
      args: [sellAmount, minBuyAmount, [sellToken, BASE_WETH], account, BigInt(Math.floor(Date.now() / 1_000) + 300)],
    }),
    value: 0n,
    gas: null,
    gasPrice: null,
  };
  assertExecutionContractPolicy({
    provider: "uniswap-v2",
    sellToken,
    transactionTarget: transaction.to,
    allowanceSpender: BASE_UNISWAP_V2_ROUTER,
  });
  return {
    provider: "uniswap-v2",
    routeTool: `uniswap-v2:${pair}`,
    providerFeeUsd: 0,
    chainId: "base",
    side: "sell",
    account,
    sellToken,
    buyToken,
    sellAmount,
    buyAmount,
    minBuyAmount,
    allowanceSpender: BASE_UNISWAP_V2_ROUTER,
    transaction,
    quotedAt: new Date().toISOString(),
  };
}

interface DexScreenerPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  labels?: string[];
  liquidity?: { usd?: number };
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
}

async function requestBaseUniswapV3BuyQuote(
  intent: EvmExecutionIntent,
  account: Address,
  sellToken: Address,
  buyToken: Address,
  sellAmount: bigint,
): Promise<EvmExecutionQuote> {
  if (intent.chainId !== "base" || intent.side !== "buy" || getAddress(sellToken) !== getAddress(NATIVE_TOKEN)) {
    throw new Error("Doğrudan Uniswap V3 fallback yalnızca Base native token alımlarında kullanılabilir.");
  }
  const publicClient = getPublicClient("base");
  const targetPool = await resolveBaseUniswapV3TargetPool(intent.preferredPairAddress, buyToken);
  const [factory, poolToken0, poolToken1, targetFee, targetLiquidity] = await Promise.all([
    publicClient.readContract({ address: targetPool, abi: UNISWAP_V3_POOL_ABI, functionName: "factory" }),
    publicClient.readContract({ address: targetPool, abi: UNISWAP_V3_POOL_ABI, functionName: "token0" }),
    publicClient.readContract({ address: targetPool, abi: UNISWAP_V3_POOL_ABI, functionName: "token1" }),
    publicClient.readContract({ address: targetPool, abi: UNISWAP_V3_POOL_ABI, functionName: "fee" }),
    publicClient.readContract({ address: targetPool, abi: UNISWAP_V3_POOL_ABI, functionName: "liquidity" }),
  ]);
  const targetTokens = new Set([getAddress(poolToken0), getAddress(poolToken1)]);
  const bridgeToken = getAddress(poolToken0) === getAddress(buyToken) ? getAddress(poolToken1) : getAddress(poolToken0);
  if (getAddress(factory) !== BASE_UNISWAP_V3_FACTORY
    || !targetTokens.has(getAddress(buyToken))
    || !targetTokens.has(bridgeToken)
    || targetLiquidity <= 0n) {
    throw new Error("Uniswap V3 hedef havuzu zincir doğrulamasından geçmedi.");
  }

  const pathParts: Array<{ token: Address; fee?: number }> = [{ token: BASE_WETH }];
  const routePools = [targetPool];
  if (bridgeToken !== BASE_WETH) {
    const bridgePool = await findBestV3Pool(publicClient, BASE_WETH, bridgeToken);
    if (!bridgePool) throw new Error("Uniswap V3 fallback için WETH ara havuzu bulunamadı.");
    pathParts.push({ token: bridgeToken, fee: bridgePool.fee });
    routePools.unshift(bridgePool.address);
  }
  pathParts.push({ token: getAddress(buyToken), fee: Number(targetFee) });
  const path = encodeV3Path(pathParts);
  const quoteResult = await publicClient.simulateContract({
    address: BASE_UNISWAP_V3_QUOTER,
    abi: UNISWAP_V3_QUOTER_ABI,
    functionName: "quoteExactInput",
    args: [path, sellAmount],
  });
  const buyAmount = quoteResult.result[0];
  const slippageBps = BigInt(Math.max(1, Math.min(9_900, Math.round(intent.slippagePercent * 100))));
  const minBuyAmount = buyAmount * (10_000n - slippageBps) / 10_000n;
  if (buyAmount <= 0n || minBuyAmount <= 0n || minBuyAmount > buyAmount) {
    throw new Error("Uniswap V3 çıkış miktarı güvenlik doğrulamasından geçmedi.");
  }
  const transaction = {
    to: BASE_UNISWAP_V3_ROUTER,
    data: encodeFunctionData({
      abi: UNISWAP_V3_ROUTER_ABI,
      functionName: "exactInput",
      args: [{ path, recipient: account, amountIn: sellAmount, amountOutMinimum: minBuyAmount }],
    }),
    value: sellAmount,
    gas: null,
    gasPrice: null,
  };
  assertExecutionContractPolicy({
    provider: "uniswap-v3",
    sellToken,
    transactionTarget: transaction.to,
    allowanceSpender: null,
  });
  return {
    provider: "uniswap-v3",
    routeTool: `uniswap-v3:${routePools.join(">")}`,
    providerFeeUsd: 0,
    chainId: "base",
    side: "buy",
    account,
    sellToken,
    buyToken,
    sellAmount,
    buyAmount,
    minBuyAmount,
    allowanceSpender: null,
    transaction,
    quotedAt: new Date().toISOString(),
  };
}

async function resolveBaseUniswapV3TargetPool(preferredPairAddress: Address | undefined, buyToken: Address) {
  if (preferredPairAddress && isAddress(preferredPairAddress)) return getAddress(preferredPairAddress);
  const response = await monitorService("dexscreener", () => fetch(
    `https://api.dexscreener.com/token-pairs/v1/base/${buyToken}`,
    { cache: "no-store", signal: AbortSignal.timeout(12_000) },
  ));
  if (!response.ok) throw new Error(`Uniswap V3 fallback piyasa verisi alınamadı (${response.status}).`);
  const pairs = await response.json() as DexScreenerPair[];
  const targetPair = pairs
    .filter((pair) => pair.chainId === "base"
      && pair.dexId === "uniswap"
      && pair.labels?.some((label) => label.toLowerCase() === "v3")
      && pair.pairAddress && isAddress(pair.pairAddress)
      && samePairToken(pair, buyToken))
    .sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0))[0];
  if (!targetPair?.pairAddress) throw new Error("Token için doğrulanabilir Base Uniswap V3 havuzu bulunamadı.");
  return getAddress(targetPair.pairAddress);
}

async function findBestV3Pool(
  publicClient: ReturnType<typeof getPublicClient>,
  tokenA: Address,
  tokenB: Address,
) {
  const candidates = await Promise.all(UNISWAP_V3_FEE_TIERS.map(async (fee) => {
    const address = getAddress(await publicClient.readContract({
      address: BASE_UNISWAP_V3_FACTORY,
      abi: UNISWAP_V3_FACTORY_ABI,
      functionName: "getPool",
      args: [tokenA, tokenB, fee],
    }));
    if (address === "0x0000000000000000000000000000000000000000") return null;
    const liquidity = await publicClient.readContract({ address, abi: UNISWAP_V3_POOL_ABI, functionName: "liquidity" });
    return liquidity > 0n ? { address, fee, liquidity } : null;
  }));
  return candidates
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    .sort((a, b) => a.liquidity === b.liquidity ? 0 : a.liquidity > b.liquidity ? -1 : 1)[0] ?? null;
}

function encodeV3Path(parts: Array<{ token: Address; fee?: number }>): Hex {
  const encoded: Hex[] = [parts[0].token];
  for (let index = 1; index < parts.length; index += 1) {
    const fee = parts[index].fee;
    if (!fee) throw new Error("Uniswap V3 rota fee değeri eksik.");
    encoded.push(numberToHex(fee, { size: 3 }), parts[index].token);
  }
  return concatHex(encoded);
}

function normalizePairToken(value: string | undefined): Address | null {
  return value && isAddress(value) ? getAddress(value) : null;
}

function samePairToken(pair: DexScreenerPair, token: Address) {
  return normalizePairToken(pair.baseToken?.address) === getAddress(token)
    || normalizePairToken(pair.quoteToken?.address) === getAddress(token);
}

export async function executeEvmQuote(quote: EvmExecutionQuote, mode: "shadow" | "live", hooks?: ExecutionSubmissionHooks): Promise<EvmExecutionResult> {
  if (quote.side === "buy") assertAssetNotDenied(quote.chainId, quote.buyToken, store.getRiskSettings());
  const publicClient = getPublicClient(quote.chainId);
  if (mode === "shadow") {
    return { mode, quote, approvalTxHash: null, txHash: null, blockNumber: null, gasUsed: null, networkFeeNativeAmount: 0n, actualSellAmount: quote.sellAmount, actualBuyAmount: quote.buyAmount };
  }
  assertLiveExecutionEnabled();
  const privateKey = await readPrivateKey("evm");
  const account = privateKeyToAccount(privateKey);
  if (account.address.toLowerCase() !== quote.account.toLowerCase()) throw new Error("Quote cüzdanı ile Keychain imzalayıcısı eşleşmiyor.");

  const trackedToken = quote.side === "buy" ? quote.buyToken : quote.sellToken;
  const tokenBalanceBefore = await publicClient.readContract({ address: trackedToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });

  const definition = CHAIN_DEFINITIONS[quote.chainId];
  const chain = defineChain({
    id: CHAIN_NUMBERS[quote.chainId],
    name: definition.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: getEvmRpcUrls(quote.chainId) } },
    blockExplorers: { default: { name: `${definition.name} Explorer`, url: definition.explorerUrl } },
  });
  const walletClient = createWalletClient({ account, chain, transport: createEvmFallbackTransport(quote.chainId, 15_000) });
  let approvalTxHash: Hex | null = null;
  let approvalGasCost = 0n;
  if (quote.sellToken !== NATIVE_TOKEN && quote.allowanceSpender) {
    const allowance = await publicClient.readContract({
      address: quote.sellToken,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, quote.allowanceSpender],
    });
    if (allowance < quote.sellAmount) {
      const simulation = await publicClient.simulateContract({
        account,
        address: quote.sellToken,
        abi: erc20Abi,
        functionName: "approve",
        args: [quote.allowanceSpender, quote.sellAmount],
      });
      approvalTxHash = await walletClient.writeContract(simulation.request);
      const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: approvalTxHash, confirmations: 1, timeout: 90_000 });
      if (approvalReceipt.status !== "success") throw new Error("Token allowance işlemi zincirde başarısız oldu.");
      approvalGasCost = approvalReceipt.gasUsed * approvalReceipt.effectiveGasPrice;
      let confirmedAllowance = 0n;
      for (let attempt = 0; attempt < 12 && confirmedAllowance < quote.sellAmount; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        confirmedAllowance = await publicClient.readContract({
          address: quote.sellToken,
          abi: erc20Abi,
          functionName: "allowance",
          args: [account.address, quote.allowanceSpender],
        });
      }
      if (confirmedAllowance < quote.sellAmount) throw new Error("Token allowance işlemi onaylandı ancak RPC güncel allowance değerini doğrulayamadı.");
    }
  }

  const nativeBalanceBeforeSwap = quote.side === "sell" ? await publicClient.getBalance({ address: account.address }) : 0n;
  await publicClient.call({ account: account.address, to: quote.transaction.to, data: quote.transaction.data, value: quote.transaction.value });

  const txHash = await walletClient.sendTransaction({
    account,
    chain,
    to: quote.transaction.to,
    data: quote.transaction.data,
    value: quote.transaction.value,
    gas: quote.transaction.gas ?? undefined,
    gasPrice: quote.transaction.gasPrice ?? undefined,
  });
  await hooks?.onSubmitted({ txHash });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error("Swap işlemi zincirde başarısız oldu.");
  let tokenBalanceAfter = await publicClient.readContract({ address: trackedToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  for (let attempt = 0; attempt < 10 && tokenBalanceAfter === tokenBalanceBefore; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    tokenBalanceAfter = await publicClient.readContract({ address: trackedToken, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  }
  if (tokenBalanceAfter === tokenBalanceBefore) {
    throw new Error("Swap zincirde onaylandı ancak token bakiye değişimi RPC üzerinden henüz doğrulanamadı; otomatik muhasebe durduruldu.");
  }
  const actualSellAmount = quote.side === "sell" ? tokenBalanceBefore - tokenBalanceAfter : quote.sellAmount;
  const nativeBalanceAfterSwap = quote.side === "sell" ? await publicClient.getBalance({ address: account.address }) : 0n;
  const swapGasCost = receipt.gasUsed * receipt.effectiveGasPrice;
  const actualBuyAmount = quote.side === "buy" ? tokenBalanceAfter - tokenBalanceBefore : nativeBalanceAfterSwap + swapGasCost - nativeBalanceBeforeSwap;
  return {
    mode,
    quote,
    approvalTxHash,
    txHash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    networkFeeNativeAmount: approvalGasCost + swapGasCost,
    actualSellAmount,
    actualBuyAmount,
  };
}

function validateZeroExQuote(
  intent: EvmExecutionIntent,
  account: Address,
  sellToken: Address,
  buyToken: Address,
  requestedSellAmount: bigint,
  payload: ZeroExQuoteResponse,
): EvmExecutionQuote {
  if (payload.liquidityAvailable === false) throw new Error("0x bu token için yürütülebilir likidite bulamadı.");
  if (!payload.transaction?.to || !isAddress(payload.transaction.to) || !payload.transaction.data?.startsWith("0x")) throw new Error("0x geçerli işlem verisi döndürmedi.");
  const sellAmount = BigInt(payload.sellAmount ?? 0);
  const buyAmount = BigInt(payload.buyAmount ?? 0);
  const minBuyAmount = BigInt(payload.minBuyAmount ?? 0);
  if (sellAmount !== requestedSellAmount || buyAmount <= 0n || minBuyAmount <= 0n || minBuyAmount > buyAmount) throw new Error("0x quote miktarları güvenlik doğrulamasından geçmedi.");
  const spender = payload.issues?.allowance?.spender;
  const allowanceSpender = sellToken === NATIVE_TOKEN ? null : spender ?? payload.transaction.to;
  if (allowanceSpender && !isAddress(allowanceSpender)) throw new Error("ERC-20 satışı için güvenli AllowanceHolder adresi bulunamadı.");
  const quote: EvmExecutionQuote = {
    provider: "0x",
    routeTool: null,
    providerFeeUsd: 0,
    chainId: intent.chainId,
    side: intent.side,
    account,
    sellToken,
    buyToken,
    sellAmount,
    buyAmount,
    minBuyAmount,
    allowanceSpender: allowanceSpender ? getAddress(allowanceSpender) : null,
    transaction: {
      to: getAddress(payload.transaction.to),
      data: payload.transaction.data as Hex,
      value: BigInt(payload.transaction.value ?? 0),
      gas: payload.transaction.gas ? BigInt(payload.transaction.gas) : null,
      gasPrice: payload.transaction.gasPrice ? BigInt(payload.transaction.gasPrice) : null,
    },
    quotedAt: new Date().toISOString(),
  };
  assertExecutionContractPolicy({
    provider: "0x",
    sellToken,
    transactionTarget: quote.transaction.to,
    allowanceSpender: quote.allowanceSpender,
  });
  return quote;
}

export function validateLifiQuote(
  intent: EvmExecutionIntent,
  account: Address,
  sellToken: Address,
  buyToken: Address,
  requestedSellAmount: bigint,
  payload: LifiQuoteResponse,
): EvmExecutionQuote {
  const chainNumber = CHAIN_NUMBERS[intent.chainId];
  const validated = validateLifiQuotePayload({ chainNumber, account, sellToken, buyToken, requestedSellAmount, payload });
  return {
    provider: "lifi",
    routeTool: validated.routeTool,
    providerFeeUsd: validated.providerFeeUsd,
    chainId: intent.chainId,
    side: intent.side,
    account,
    sellToken,
    buyToken,
    sellAmount: requestedSellAmount,
    buyAmount: validated.buyAmount,
    minBuyAmount: validated.minBuyAmount,
    allowanceSpender: validated.allowanceSpender,
    transaction: validated.transaction,
    quotedAt: new Date().toISOString(),
  };
}
