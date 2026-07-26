import {
  createWalletClient,
  decodeEventLog,
  defineChain,
  erc20Abi,
  getAddress,
  isAddress,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getPublicClient } from "@/lib/chains/public-client";
import { createEvmFallbackTransport, getEvmRpcUrls } from "@/lib/chains/evm-rpc-pool";
import { CHAIN_DEFINITIONS } from "@/lib/domain/defaults";
import type { TradeSide, TradingMode } from "@/lib/domain/types";
import { calculateNativeBuyAmount, calculateTokenSellAmount } from "@/lib/execution/evm-execution-math";
import { buildRouterTransaction, type RobinhoodPoolKey as PoolKey } from "@/lib/execution/robinhood-v4-calldata";
import { readPrivateKey } from "@/lib/security/keychain";
import { assertLiveExecutionEnabled } from "@/lib/execution/live-execution-switch";
import { getExecutionAccount } from "@/lib/services/execution-account-service";
import { store } from "@/lib/repositories/store";
import { assertAssetNotDenied } from "@/lib/engine/asset-execution-policy";
import type { ExecutionSubmissionHooks } from "@/lib/execution/execution-adapter";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Address;
const UNIVERSAL_ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904" as Address;
const V4_QUOTER = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94" as Address;
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3" as Address;
const UINT160_MAX = (1n << 160n) - 1n;

const INITIALIZE_EVENT = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);
const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);
const PERMIT2_ABI = parseAbi([
  "function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)",
  "function approve(address token,address spender,uint160 amount,uint48 expiration)",
]);

interface DexPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  pairCreatedAt?: number;
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
  liquidity?: { usd?: number };
}


export interface RobinhoodExecutionIntent {
  side: TradeSide;
  tokenAddress: Address;
  allocationPercent?: number;
  sellPercent?: number;
  exactSellAmount?: bigint;
  slippagePercent: number;
  mode: Exclude<TradingMode, "paper">;
}

export interface RobinhoodExecutionQuote {
  chainId: "robinhood";
  side: TradeSide;
  account: Address;
  tokenAddress: Address;
  poolId: Hex;
  poolKey: PoolKey;
  sellAmount: bigint;
  buyAmount: bigint;
  minBuyAmount: bigint;
  transaction: { to: Address; data: Hex; value: bigint };
  quotedAt: string;
}

export interface RobinhoodExecutionResult {
  mode: "shadow" | "live";
  quote: RobinhoodExecutionQuote;
  tokenApprovalTxHash: Hex | null;
  permit2ApprovalTxHash: Hex | null;
  txHash: Hex | null;
  blockNumber: bigint | null;
  gasUsed: bigint | null;
  networkFeeNativeAmount: bigint;
  actualSellAmount: bigint;
  actualBuyAmount: bigint;
}

const poolCache = new Map<string, { poolId: Hex; poolKey: PoolKey; expiresAt: number }>();

export async function prepareRobinhoodExecution(intent: RobinhoodExecutionIntent): Promise<RobinhoodExecutionQuote> {
  if (!isAddress(intent.tokenAddress)) throw new Error("Geçerli token kontrat adresi gerekli.");
  if (intent.slippagePercent < 0 || intent.slippagePercent > 20) throw new Error("Slippage oranı 0-20 aralığında olmalı.");
  const accountAddress = intent.mode === "shadow"
    ? getExecutionAccount("evm")
    : privateKeyToAccount(await readPrivateKey("evm")).address;
  if (!accountAddress || !isAddress(accountAddress)) throw new Error("EVM işlem hesabı yapılandırılmadı.");
  const accountAddressNormalized = getAddress(accountAddress);
  const tokenAddress = getAddress(intent.tokenAddress);
  const publicClient = getPublicClient("robinhood");
  const balance = intent.side === "buy"
    ? await publicClient.getBalance({ address: accountAddressNormalized })
    : await publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [accountAddressNormalized] });
  const sellAmount = intent.side === "buy"
    ? calculateNativeBuyAmount(balance, intent.allocationPercent ?? 7.5)
    : intent.exactSellAmount === undefined
      ? calculateTokenSellAmount(balance, intent.sellPercent ?? 100)
      : intent.exactSellAmount > balance ? balance : intent.exactSellAmount;
  if (sellAmount <= 0n) throw new Error(intent.side === "buy" ? "Gas rezervi sonrasında kullanılabilir ETH yok." : "Satılabilecek token bakiyesi yok.");

  const candidates = await resolvePools(tokenAddress);
  let selected: { poolId: Hex; poolKey: PoolKey; buyAmount: bigint } | null = null;
  let lastQuoteError: Error | null = null;
  for (const candidate of candidates) {
    const zeroForOne = intent.side === "buy"
      ? candidate.poolKey.currency0 === ZERO_ADDRESS
      : candidate.poolKey.currency0 === tokenAddress;
    try {
      const quoteResult = await publicClient.readContract({
        address: V4_QUOTER,
        abi: QUOTER_ABI,
        functionName: "quoteExactInputSingle",
        args: [{ poolKey: candidate.poolKey, zeroForOne, exactAmount: sellAmount, hookData: "0x" }],
      }) as unknown as readonly [bigint, bigint];
      if (quoteResult[0] > 0n) {
        selected = { ...candidate, buyAmount: quoteResult[0] };
        break;
      }
    } catch (error) {
      lastQuoteError = error instanceof Error ? error : new Error("Robinhood quote alınamadı.");
    }
  }
  if (!selected) {
    throw new Error(`Doğrulanmış Robinhood havuzlarından yürütülebilir quote alınamadı.${lastQuoteError ? ` ${lastQuoteError.message}` : ""}`);
  }
  const { poolId, poolKey, buyAmount } = selected;
  poolCache.set(tokenAddress.toLowerCase(), { poolId, poolKey, expiresAt: Date.now() + 60 * 60 * 1000 });
  const zeroForOne = intent.side === "buy" ? poolKey.currency0 === ZERO_ADDRESS : poolKey.currency0 === tokenAddress;
  if (buyAmount <= 0n) throw new Error("Robinhood Uniswap v4 quote sıfır çıktı.");
  const minBuyAmount = buyAmount * BigInt(Math.floor((100 - intent.slippagePercent) * 100)) / 10_000n;
  if (minBuyAmount <= 0n) throw new Error("Minimum alınacak miktar sıfır olamaz.");
  const transaction = buildRouterTransaction(poolKey, zeroForOne, sellAmount, minBuyAmount, intent.side);

  if (intent.side === "buy") {
    await publicClient.call({ account: accountAddressNormalized, to: transaction.to, data: transaction.data, value: transaction.value });
  }
  return {
    chainId: "robinhood",
    side: intent.side,
    account: accountAddressNormalized,
    tokenAddress,
    poolId,
    poolKey,
    sellAmount,
    buyAmount,
    minBuyAmount,
    transaction,
    quotedAt: new Date().toISOString(),
  };
}

export async function executeRobinhoodQuote(quote: RobinhoodExecutionQuote, mode: "shadow" | "live", hooks?: ExecutionSubmissionHooks): Promise<RobinhoodExecutionResult> {
  if (quote.side === "buy") assertAssetNotDenied("robinhood", quote.tokenAddress, store.getRiskSettings());
  const publicClient = getPublicClient("robinhood");
  if (quote.side === "buy") {
    await publicClient.call({ account: quote.account, to: quote.transaction.to, data: quote.transaction.data, value: quote.transaction.value });
  }
  if (mode === "shadow") {
    if (quote.side === "sell" && await hasSellAllowances(quote, quote.account)) {
      await publicClient.call({ account: quote.account, to: quote.transaction.to, data: quote.transaction.data, value: 0n });
    }
    return emptyResult(mode, quote);
  }
  assertLiveExecutionEnabled();
  const privateKey = await readPrivateKey("evm");
  const account = privateKeyToAccount(privateKey);
  if (account.address.toLowerCase() !== quote.account.toLowerCase()) throw new Error("Quote cüzdanı ile Keychain imzalayıcısı eşleşmiyor.");
  const tokenBalanceBefore = await publicClient.readContract({ address: quote.tokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });

  const definition = CHAIN_DEFINITIONS.robinhood;
  const chain = defineChain({
    id: 4663,
    name: definition.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: getEvmRpcUrls("robinhood") } },
    blockExplorers: { default: { name: "Robinhood Explorer", url: definition.explorerUrl } },
  });
  const walletClient = createWalletClient({ account, chain, transport: createEvmFallbackTransport("robinhood", 15_000) });
  let tokenApprovalTxHash: Hex | null = null;
  let permit2ApprovalTxHash: Hex | null = null;
  let approvalGasCost = 0n;

  if (quote.side === "sell") {
    const tokenAllowance = await publicClient.readContract({ address: quote.tokenAddress, abi: erc20Abi, functionName: "allowance", args: [account.address, PERMIT2] });
    if (tokenAllowance < quote.sellAmount) {
      const approval = await publicClient.simulateContract({ account, address: quote.tokenAddress, abi: erc20Abi, functionName: "approve", args: [PERMIT2, quote.sellAmount] });
      tokenApprovalTxHash = await walletClient.writeContract(approval.request);
      approvalGasCost += await requireSuccessfulReceipt(tokenApprovalTxHash, "Token Permit2 izni");
      const confirmedAllowance = await pollValue(
        () => publicClient.readContract({ address: quote.tokenAddress, abi: erc20Abi, functionName: "allowance", args: [account.address, PERMIT2] }),
        (value) => value >= quote.sellAmount,
      );
      if (confirmedAllowance < quote.sellAmount) throw new Error("Token Permit2 izni onaylandı ancak RPC güncel allowance değerini doğrulayamadı.");
    }
    const [permitAmount, permitExpiration] = await publicClient.readContract({ address: PERMIT2, abi: PERMIT2_ABI, functionName: "allowance", args: [account.address, quote.tokenAddress, UNIVERSAL_ROUTER] });
    const expiration = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);
    if (permitAmount < quote.sellAmount || permitExpiration <= BigInt(Math.floor(Date.now() / 1000) + 60)) {
      if (quote.sellAmount > UINT160_MAX) throw new Error("Satış miktarı Permit2 uint160 sınırını aşıyor.");
      const approval = await publicClient.simulateContract({ account, address: PERMIT2, abi: PERMIT2_ABI, functionName: "approve", args: [quote.tokenAddress, UNIVERSAL_ROUTER, quote.sellAmount, Number(expiration)] });
      permit2ApprovalTxHash = await walletClient.writeContract(approval.request);
      approvalGasCost += await requireSuccessfulReceipt(permit2ApprovalTxHash, "Universal Router Permit2 izni");
      const confirmedPermit = await pollValue(
        () => publicClient.readContract({ address: PERMIT2, abi: PERMIT2_ABI, functionName: "allowance", args: [account.address, quote.tokenAddress, UNIVERSAL_ROUTER] }),
        ([amount, expiresAt]) => amount >= quote.sellAmount && expiresAt > BigInt(Math.floor(Date.now() / 1000) + 60),
      );
      if (confirmedPermit[0] < quote.sellAmount || confirmedPermit[1] <= BigInt(Math.floor(Date.now() / 1000) + 60)) {
        throw new Error("Universal Router Permit2 izni onaylandı ancak RPC güncel izni doğrulayamadı.");
      }
    }
  }

  const nativeBalanceBeforeSwap = quote.side === "sell" ? await publicClient.getBalance({ address: account.address }) : 0n;
  await publicClient.call({ account: account.address, to: quote.transaction.to, data: quote.transaction.data, value: quote.transaction.value });
  const txHash = await walletClient.sendTransaction({ account, chain, ...quote.transaction });
  await hooks?.onSubmitted({ txHash });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error("Robinhood swap işlemi zincirde başarısız oldu.");
  const tokenBalanceAfter = await pollValue(
    () => publicClient.readContract({ address: quote.tokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    (value) => quote.side === "buy" ? value > tokenBalanceBefore : value < tokenBalanceBefore,
  );
  const tokenBalanceChanged = quote.side === "buy" ? tokenBalanceAfter > tokenBalanceBefore : tokenBalanceAfter < tokenBalanceBefore;
  if (!tokenBalanceChanged) {
    throw new Error("Robinhood swap zincirde onaylandı ancak token bakiye değişimi RPC üzerinden doğrulanamadı; otomatik muhasebe durduruldu.");
  }
  const actualSellAmount = quote.side === "sell" ? tokenBalanceBefore - tokenBalanceAfter : quote.sellAmount;
  const nativeBalanceAfterSwap = quote.side === "sell"
    ? await pollValue(() => publicClient.getBalance({ address: account.address }), (value) => value !== nativeBalanceBeforeSwap)
    : 0n;
  const swapGasCost = receipt.gasUsed * receipt.effectiveGasPrice;
  const actualBuyAmount = quote.side === "buy" ? tokenBalanceAfter - tokenBalanceBefore : nativeBalanceAfterSwap + swapGasCost - nativeBalanceBeforeSwap;
  return {
    mode,
    quote,
    tokenApprovalTxHash,
    permit2ApprovalTxHash,
    txHash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    networkFeeNativeAmount: approvalGasCost + swapGasCost,
    actualSellAmount,
    actualBuyAmount,
  };

  async function requireSuccessfulReceipt(hash: Hex, label: string) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 90_000 });
    if (receipt.status !== "success") throw new Error(`${label} zincirde başarısız oldu.`);
    return receipt.gasUsed * receipt.effectiveGasPrice;
  }

  async function pollValue<T>(read: () => Promise<T>, isCurrent: (value: T) => boolean): Promise<T> {
    let value = await read();
    for (let attempt = 0; attempt < 12 && !isCurrent(value); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      value = await read();
    }
    return value;
  }

  async function hasSellAllowances(currentQuote: RobinhoodExecutionQuote, owner: Address) {
    const tokenAllowance = await publicClient.readContract({ address: currentQuote.tokenAddress, abi: erc20Abi, functionName: "allowance", args: [owner, PERMIT2] });
    const [permitAmount, permitExpiration] = await publicClient.readContract({ address: PERMIT2, abi: PERMIT2_ABI, functionName: "allowance", args: [owner, currentQuote.tokenAddress, UNIVERSAL_ROUTER] });
    return tokenAllowance >= currentQuote.sellAmount && permitAmount >= currentQuote.sellAmount && permitExpiration > BigInt(Math.floor(Date.now() / 1000) + 60);
  }
}

export async function verifyRobinhoodSellRoute(quote: RobinhoodExecutionQuote) {
  if (quote.side !== "buy" || quote.buyAmount <= 0n) return false;
  const zeroForOne = quote.poolKey.currency0 === quote.tokenAddress;
  const result = await getPublicClient("robinhood").readContract({
    address: V4_QUOTER,
    abi: QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey: quote.poolKey, zeroForOne, exactAmount: quote.buyAmount, hookData: "0x" }],
  }) as unknown as readonly [bigint, bigint];
  return result[0] > 0n;
}

async function resolvePools(tokenAddress: Address): Promise<Array<{ poolId: Hex; poolKey: PoolKey }>> {
  const cached = poolCache.get(tokenAddress.toLowerCase());
  if (cached && cached.expiresAt > Date.now()) return [cached];
  const response = await fetch(`https://api.dexscreener.com/token-pairs/v1/robinhood/${tokenAddress}`, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`DexScreener Robinhood havuzları alınamadı (${response.status}).`);
  const pairs = await response.json() as DexPair[];
  const candidates = pairs
    .filter((item) => item.dexId?.toLowerCase().includes("uniswap") && item.pairAddress?.startsWith("0x") && item.pairAddress.length === 66 && item.pairCreatedAt)
    .filter((item) => [item.baseToken?.address, item.quoteToken?.address].some((address) => address?.toLowerCase() === tokenAddress.toLowerCase()))
    .filter((item) => [item.baseToken?.address, item.quoteToken?.address].some((address) => address?.toLowerCase() === ZERO_ADDRESS))
    .sort((left, right) => Number(right.liquidity?.usd ?? 0) - Number(left.liquidity?.usd ?? 0))
    .slice(0, 4);
  if (!candidates.length) throw new Error("Token için doğrulanabilir Robinhood Uniswap v4 ETH havuzu bulunamadı.");
  const verified: Array<{ poolId: Hex; poolKey: PoolKey }> = [];
  let hookPoolCount = 0;
  for (const pair of candidates) {
    if (!pair.pairAddress || !pair.pairCreatedAt) continue;
    try {
      const poolId = pair.pairAddress as Hex;
      const poolKey = await findPoolInitialize(poolId, pair.pairCreatedAt);
      const currencies = [poolKey.currency0.toLowerCase(), poolKey.currency1.toLowerCase()];
      if (!currencies.includes(ZERO_ADDRESS) || !currencies.includes(tokenAddress.toLowerCase())) continue;
      if (poolKey.hooks !== ZERO_ADDRESS) {
        hookPoolCount += 1;
        continue;
      }
      verified.push({ poolId, poolKey });
    } catch {
      continue;
    }
  }
  if (!verified.length) {
    if (hookPoolCount > 0) throw new Error("Hooks kullanan Robinhood havuzları canlı işlem için henüz izinli değil.");
    throw new Error("Token için doğrulanabilir Robinhood Uniswap v4 ETH havuzu bulunamadı.");
  }
  return verified;
}

async function findPoolInitialize(poolId: Hex, pairCreatedAt: number): Promise<PoolKey> {
  const publicClient = getPublicClient("robinhood");
  const latest = await publicClient.getBlockNumber();
  const targetTimestamp = BigInt(Math.floor(pairCreatedAt / 1000));
  let low = 0n;
  let high = latest;
  while (low < high) {
    const mid = (low + high) / 2n;
    const block = await publicClient.getBlock({ blockNumber: mid });
    if (block.timestamp < targetTimestamp) low = mid + 1n;
    else high = mid;
  }
  const from = low > 120n ? low - 120n : 0n;
  const to = low + 120n < latest ? low + 120n : latest;
  for (let block = from; block <= to; block += 10n) {
    const logs = await publicClient.getLogs({ address: POOL_MANAGER, event: INITIALIZE_EVENT[0], args: { id: poolId }, fromBlock: block, toBlock: block + 9n > to ? to : block + 9n });
    const log = logs[0];
    if (!log) continue;
    const decoded = decodeEventLog({ abi: INITIALIZE_EVENT, data: log.data, topics: log.topics });
    const args = decoded.args;
    return {
      currency0: getAddress(args.currency0),
      currency1: getAddress(args.currency1),
      fee: args.fee,
      tickSpacing: args.tickSpacing,
      hooks: getAddress(args.hooks),
    };
  }
  throw new Error("Robinhood havuzunun zincir üstü Initialize kaydı doğrulanamadı.");
}

function emptyResult(mode: "shadow", quote: RobinhoodExecutionQuote): RobinhoodExecutionResult {
  return { mode, quote, tokenApprovalTxHash: null, permit2ApprovalTxHash: null, txHash: null, blockNumber: null, gasUsed: null, networkFeeNativeAmount: 0n, actualSellAmount: quote.sellAmount, actualBuyAmount: quote.buyAmount };
}

export async function checkRobinhoodV4Deployments() {
  const publicClient = getPublicClient("robinhood");
  const codes = await Promise.all([POOL_MANAGER, UNIVERSAL_ROUTER, V4_QUOTER, PERMIT2].map((address) => publicClient.getCode({ address })));
  return codes.every((code) => Boolean(code && code !== "0x"));
}
