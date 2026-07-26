import { getAddress, isAddress, type Address, type Hex } from "viem";

export const ZERO_EX_ALLOWANCE_HOLDER = getAddress("0x0000000000001fF3684f28c67538d4D072C22734");
export const LIFI_DIAMOND = getAddress("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE");

const NATIVE_TOKEN_ALIASES = new Set([
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "0x0000000000000000000000000000000000000000",
]);

export function assertTrustedExecutionApi(provider: "0x" | "lifi", baseUrl: string) {
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    throw new Error(`${provider} swap API adresi geçersiz.`);
  }
  const expectedOrigin = provider === "0x" ? "https://api.0x.org" : "https://li.quest";
  if (origin !== expectedOrigin) {
    throw new Error(`${provider} swap API kaynağı doğrulanamadı: ${origin}`);
  }
}

export function assertExecutionContractPolicy(input: {
  provider: "0x" | "lifi";
  sellToken: Address;
  transactionTarget: Address;
  allowanceSpender: Address | null;
}) {
  if (input.provider === "lifi") {
    if (getAddress(input.transactionTarget) !== LIFI_DIAMOND) {
      throw new Error("LI.FI işlemi resmî Diamond kontratını hedeflemiyor.");
    }
    if (!isNativeToken(input.sellToken) && input.allowanceSpender && getAddress(input.allowanceSpender) !== LIFI_DIAMOND) {
      throw new Error("LI.FI token izni resmî Diamond kontratını hedeflemiyor.");
    }
    return;
  }

  if (input.allowanceSpender && getAddress(input.allowanceSpender) !== ZERO_EX_ALLOWANCE_HOLDER) {
    throw new Error("0x token izni resmî AllowanceHolder kontratını hedeflemiyor.");
  }
  if (!isNativeToken(input.sellToken) && getAddress(input.transactionTarget) !== ZERO_EX_ALLOWANCE_HOLDER) {
    throw new Error("0x ERC-20 swap işlemi resmî AllowanceHolder kontratını hedeflemiyor.");
  }
}

export interface LifiQuoteResponse {
  action?: {
    fromChainId?: number | string;
    toChainId?: number | string;
    fromAmount?: string;
    fromAddress?: string;
    toAddress?: string;
    fromToken?: { address?: string };
    toToken?: { address?: string };
  };
  estimate?: { toAmount?: string; toAmountMin?: string; approvalAddress?: string; feeCosts?: Array<{ amountUSD?: string }> };
  tool?: string;
  transactionRequest?: {
    from?: string;
    to?: string;
    data?: string;
    value?: string;
    gasLimit?: string;
    gasPrice?: string;
    chainId?: number | string;
  };
}

export function isZeroExRouteUnavailable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /yürütülebilir likidite bulamadı|no (?:quote|route|liquidity)|insufficient liquidity|liquidity unavailable|token.*not supported|rota simülasyonu başarısız|execution reverted/i.test(message);
}

export function validateLifiQuotePayload(input: {
  chainNumber: number;
  account: Address;
  sellToken: Address;
  buyToken: Address;
  requestedSellAmount: bigint;
  payload: LifiQuoteResponse;
}) {
  const { action, transactionRequest: transaction } = input.payload;
  if (!action || Number(action.fromChainId) !== input.chainNumber || Number(action.toChainId) !== input.chainNumber || Number(transaction?.chainId) !== input.chainNumber) {
    throw new Error("LI.FI quote zincir doğrulamasından geçmedi.");
  }
  if (action.fromAmount !== input.requestedSellAmount.toString()) throw new Error("LI.FI satış miktarı istekle eşleşmiyor.");
  if (!sameToken(action.fromToken?.address, input.sellToken) || !sameToken(action.toToken?.address, input.buyToken)) throw new Error("LI.FI token çifti istekle eşleşmiyor.");
  if (!sameAddress(action.fromAddress, input.account) || !sameAddress(action.toAddress, input.account) || !sameAddress(transaction?.from, input.account)) {
    throw new Error("LI.FI işlem hesabı istekle eşleşmiyor.");
  }
  if (!transaction?.to || !isAddress(transaction.to) || !transaction.data?.startsWith("0x")) throw new Error("LI.FI geçerli işlem verisi döndürmedi.");
  const buyAmount = BigInt(input.payload.estimate?.toAmount ?? 0);
  const minBuyAmount = BigInt(input.payload.estimate?.toAmountMin ?? 0);
  if (buyAmount <= 0n || minBuyAmount <= 0n || minBuyAmount > buyAmount) throw new Error("LI.FI quote miktarları güvenlik doğrulamasından geçmedi.");
  const spender = input.payload.estimate?.approvalAddress;
  if (!isNativeToken(input.sellToken) && (!spender || !isAddress(spender))) throw new Error("LI.FI ERC-20 satışı için güvenli allowance adresi döndürmedi.");
  const value = BigInt(transaction.value ?? 0);
  if ((isNativeToken(input.sellToken) && value !== input.requestedSellAmount) || (!isNativeToken(input.sellToken) && value !== 0n)) {
    throw new Error("LI.FI işlem native değeri satış varlığıyla eşleşmiyor.");
  }
  const result = {
    buyAmount,
    minBuyAmount,
    allowanceSpender: spender ? getAddress(spender) : null,
    routeTool: input.payload.tool?.trim() || null,
    providerFeeUsd: (input.payload.estimate?.feeCosts ?? []).reduce((total, fee) => total + finiteUsd(fee.amountUSD), 0),
    transaction: {
      to: getAddress(transaction.to),
      data: transaction.data as Hex,
      value,
      gas: transaction.gasLimit ? BigInt(transaction.gasLimit) : null,
      gasPrice: transaction.gasPrice ? BigInt(transaction.gasPrice) : null,
    },
  };
  assertExecutionContractPolicy({
    provider: "lifi",
    sellToken: input.sellToken,
    transactionTarget: result.transaction.to,
    allowanceSpender: result.allowanceSpender,
  });
  return result;
}

function finiteUsd(value: string | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function sameAddress(value: string | undefined, expected: Address) {
  return Boolean(value && isAddress(value) && getAddress(value) === getAddress(expected));
}

function sameToken(value: string | undefined, expected: Address) {
  if (!value) return false;
  const normalizedValue = value.toLowerCase();
  const normalizedExpected = expected.toLowerCase();
  return normalizedValue === normalizedExpected || (NATIVE_TOKEN_ALIASES.has(normalizedValue) && NATIVE_TOKEN_ALIASES.has(normalizedExpected));
}

function isNativeToken(token: Address) {
  return NATIVE_TOKEN_ALIASES.has(token.toLowerCase());
}
