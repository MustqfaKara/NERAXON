import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import type { ObservedTransaction, SwapObservation } from "@/lib/chains/chain-adapter";
import { getPublicClient } from "@/lib/chains/public-client";
import type { MarketSnapshot } from "@/lib/services/market-data-provider";
import { getEvmNativeMarketPrice } from "@/lib/services/gas-estimator";

export const ROBINHOOD_PORTAL_ROUTER = "0x65050A9b7E5075A2bA5cED7b1b64EE66262c40Dc" as Address;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const ZERO_POOL_ID = `0x${"0".repeat(64)}` as Hex;
const PORTAL_ROUTE_TYPE = 6;
const PORTAL_QUOTE_ITERATIONS = 32;

const PORTAL_ROUTER_ABI = parseAbi([
  "function swap((uint8 routeType,address tokenIn,address tokenOut,address token,uint24 fee,int24 tickSpacing,address hooks,bytes hookData,address factory,bytes32 poolId)[] routes,address feeToken,uint256 amountIn,uint256 minReturn,uint256 deadline) payable",
]);

interface PortalRoute {
  routeType: number;
  tokenIn: Address;
  tokenOut: Address;
  token: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  hookData: Hex;
  factory: Address;
  poolId: Hex;
}

export interface RobinhoodPortalMarket extends MarketSnapshot {
  marketKind: "robinhood-portal";
  exitRouteVerified: true;
}

export function decodeRobinhoodPortalSwap(transaction: Pick<ObservedTransaction, "to" | "input">) {
  if (transaction.to?.toLowerCase() !== ROBINHOOD_PORTAL_ROUTER.toLowerCase()) return null;
  try {
    const decoded = decodeFunctionData({ abi: PORTAL_ROUTER_ABI, data: transaction.input as Hex });
    if (decoded.functionName !== "swap") return null;
    const [routes, , amountIn, minReturn, deadline] = decoded.args;
    if (routes.length !== 1 || Number(routes[0].routeType) !== PORTAL_ROUTE_TYPE) return null;
    return { route: routes[0], amountIn, minReturn, deadline };
  } catch {
    return null;
  }
}

export async function resolveRobinhoodPortalMarket(
  transaction: ObservedTransaction,
  observation: SwapObservation,
): Promise<RobinhoodPortalMarket | null> {
  const decoded = decodeRobinhoodPortalSwap(transaction);
  if (!decoded || observation.side !== "buy" || transaction.value <= 0n || observation.tokenAmount <= 0) return null;
  const routeToken = getAddress(decoded.route.token);
  if (routeToken.toLowerCase() !== observation.tokenAddress.toLowerCase()) return null;

  const exitRouteVerified = await verifyObservedPortalExitRoute({
    tokenAddress: routeToken,
    sourceAccount: getAddress(transaction.from),
    tokenAmount: tokenAmountToBaseUnits(observation.tokenAmount, observation.tokenDecimals),
    blockNumber: BigInt(transaction.blockNumber),
  });
  if (!exitRouteVerified) return null;

  const [nativePriceUsd, totalSupply, sourceBlock] = await Promise.all([
    getEvmNativeMarketPrice("robinhood"),
    getPublicClient("robinhood").readContract({
      address: routeToken,
      abi: erc20Abi,
      functionName: "totalSupply",
    }),
    getPublicClient("robinhood").getBlock({ blockNumber: BigInt(transaction.blockNumber) }),
  ]);
  const sourceValueUsd = Number(formatEther(transaction.value)) * nativePriceUsd;
  const priceUsd = sourceValueUsd / observation.tokenAmount;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;

  return {
    chainId: "robinhood",
    tokenAddress: routeToken.toLowerCase(),
    tokenSymbol: observation.tokenSymbol,
    priceUsd,
    liquidityUsd: 0,
    volume24hUsd: 0,
    priceChange24hPercent: 0,
    marketCapUsd: Number(formatUnits(totalSupply, observation.tokenDecimals)) * priceUsd,
    fdvUsd: Number(formatUnits(totalSupply, observation.tokenDecimals)) * priceUsd,
    pairAddress: ROBINHOOD_PORTAL_ROUTER,
    dexId: "robinhood-portal",
    pairCreatedAt: Number(sourceBlock.timestamp) * 1000,
    fetchedAt: new Date().toISOString(),
    buys24h: 0,
    sells24h: 0,
    marketKind: "robinhood-portal",
    exitRouteVerified: true,
  };
}

export function buildRobinhoodPortalTransaction(input: {
  side: "buy" | "sell";
  tokenAddress: Address;
  amountIn: bigint;
  minReturn: bigint;
}) {
  const route = createPortalRoute(input.side, input.tokenAddress);
  const data = encodeFunctionData({
    abi: PORTAL_ROUTER_ABI,
    functionName: "swap",
    args: [[route], ZERO_ADDRESS, input.amountIn, input.minReturn, input.side === "buy" ? BigInt(Math.floor(Date.now() / 1000) + 10 * 60) : 0n],
  });
  return {
    to: ROBINHOOD_PORTAL_ROUTER,
    data,
    value: input.side === "buy" ? input.amountIn : 0n,
  };
}

export async function quoteRobinhoodPortalBuy(input: {
  account: Address;
  tokenAddress: Address;
  amountIn: bigint;
}) {
  const client = getPublicClient("robinhood");
  const totalSupply = await client.readContract({
    address: input.tokenAddress,
    abi: erc20Abi,
    functionName: "totalSupply",
  });
  let low = 0n;
  let high = totalSupply;
  for (let iteration = 0; iteration < PORTAL_QUOTE_ITERATIONS && low < high; iteration += 1) {
    const midpoint = (low + high + 1n) / 2n;
    const transaction = buildRobinhoodPortalTransaction({
      side: "buy",
      tokenAddress: input.tokenAddress,
      amountIn: input.amountIn,
      minReturn: midpoint,
    });
    const succeeds = await client.call({
      account: input.account,
      ...transaction,
    }).then(() => true).catch(() => false);
    if (succeeds) low = midpoint;
    else high = midpoint - 1n;
  }
  if (low <= 0n) throw new Error("Robinhood Portal zincir üstü alım quote'u alınamadı.");
  return low;
}

export async function quoteRobinhoodPortalSell(input: {
  account: Address;
  tokenAddress: Address;
  amountIn: bigint;
}) {
  const client = getPublicClient("robinhood");
  let low = 0n;
  let high = 10n ** 18n;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const transaction = buildRobinhoodPortalTransaction({
      side: "sell",
      tokenAddress: input.tokenAddress,
      amountIn: input.amountIn,
      minReturn: high,
    });
    const succeeds = await client.call({ account: input.account, ...transaction })
      .then(() => true)
      .catch(() => false);
    if (!succeeds) break;
    low = high;
    high *= 2n;
  }
  for (let iteration = 0; iteration < PORTAL_QUOTE_ITERATIONS && low < high; iteration += 1) {
    const midpoint = (low + high + 1n) / 2n;
    const transaction = buildRobinhoodPortalTransaction({
      side: "sell",
      tokenAddress: input.tokenAddress,
      amountIn: input.amountIn,
      minReturn: midpoint,
    });
    const succeeds = await client.call({ account: input.account, ...transaction })
      .then(() => true)
      .catch(() => false);
    if (succeeds) low = midpoint;
    else high = midpoint - 1n;
  }
  if (low <= 0n) throw new Error("Robinhood Portal zincir üstü satış quote'u alınamadı.");
  return low;
}

export async function verifyObservedPortalExitRoute(input: {
  tokenAddress: Address;
  sourceAccount: Address;
  tokenAmount: bigint;
  blockNumber: bigint;
}) {
  const transaction = buildRobinhoodPortalTransaction({
    side: "sell",
    tokenAddress: input.tokenAddress,
    amountIn: input.tokenAmount,
    minReturn: 1n,
  });
  try {
    await getPublicClient("robinhood").call({
      account: input.sourceAccount,
      ...transaction,
      blockNumber: input.blockNumber,
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    return message.includes("insufficient allowance");
  }
}

function createPortalRoute(side: "buy" | "sell", tokenAddress: Address): PortalRoute {
  return {
    routeType: PORTAL_ROUTE_TYPE,
    tokenIn: side === "buy" ? ZERO_ADDRESS : tokenAddress,
    tokenOut: side === "buy" ? tokenAddress : ZERO_ADDRESS,
    token: tokenAddress,
    fee: 0,
    tickSpacing: 0,
    hooks: ZERO_ADDRESS,
    hookData: "0x",
    factory: ZERO_ADDRESS,
    poolId: ZERO_POOL_ID,
  };
}

function tokenAmountToBaseUnits(amount: number, decimals: number) {
  const [whole = "0", fraction = ""] = amount.toFixed(Math.min(decimals, 12)).split(".");
  return BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
}
