import assert from "node:assert/strict";
import test from "node:test";
import { getAddress } from "viem";
import {
  assertExecutionContractPolicy,
  assertTrustedExecutionApi,
  BASE_UNISWAP_V2_ROUTER,
  BASE_UNISWAP_V3_ROUTER,
  isLifiRouteUnavailable,
  isZeroExRouteUnavailable,
  LIFI_DIAMOND,
  validateLifiQuotePayload,
  ZERO_EX_ALLOWANCE_HOLDER,
} from "../src/lib/execution/evm-route-validation.ts";

const account = getAddress("0x0000000000000000000000000000000000000001");
const nativeToken = getAddress("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
const buyToken = getAddress("0x0000000000000000000000000000000000000002");

test("yalnızca rota bulunamaması LI.FI fallback açar", () => {
  assert.equal(isZeroExRouteUnavailable(new Error("0x bu token için yürütülebilir likidite bulamadı.")), true);
  assert.equal(isZeroExRouteUnavailable(new Error("0x quote alınamadı (400): SWAP_VALIDATION_FAILED · Swap validation failed")), true);
  assert.equal(isZeroExRouteUnavailable(new Error("0x quote alınamadı (451): legal restriction")), false);
  assert.equal(isZeroExRouteUnavailable(new Error("0x quote miktarları güvenlik doğrulamasından geçmedi.")), false);
});

test("LI.FI denylist cevabı yalnızca doğrulanmış DEX fallback'ini açar", () => {
  assert.equal(isLifiRouteUnavailable(new Error("LI.FI quote alınamadı (400): Token 8453-0xabc is invalid or in deny list.")), true);
  assert.equal(isLifiRouteUnavailable(new Error("lifi rota simülasyonu başarısız: Execution reverted for an unknown reason.")), true);
  assert.equal(isLifiRouteUnavailable(new Error("LI.FI quote zincir doğrulamasından geçmedi.")), false);
  assert.equal(isLifiRouteUnavailable(new Error("LI.FI işlemi resmî Diamond kontratını hedeflemiyor.")), false);
});

test("LI.FI quote hesap, zincir, token ve native değeri doğrulanır", () => {
  const quote = validateLifiQuotePayload({
    chainNumber: 8453,
    account,
    sellToken: nativeToken,
    buyToken,
    requestedSellAmount: 100n,
    payload: {
      action: { fromChainId: 8453, toChainId: 8453, fromAmount: "100", fromAddress: account, toAddress: account, fromToken: { address: nativeToken }, toToken: { address: buyToken } },
      estimate: { toAmount: "200", toAmountMin: "190", feeCosts: [{ amountUSD: "0.0048" }] },
      tool: "uniswap",
      transactionRequest: { from: account, to: LIFI_DIAMOND, data: "0x1234", value: "100", gasLimit: "100000", gasPrice: "1", chainId: 8453 },
    },
  });
  assert.equal(quote.buyAmount, 200n);
  assert.equal(quote.providerFeeUsd, 0.0048);
});

test("yalnızca resmî swap API kaynakları kabul edilir", () => {
  assert.doesNotThrow(() => assertTrustedExecutionApi("0x", "https://api.0x.org"));
  assert.doesNotThrow(() => assertTrustedExecutionApi("lifi", "https://li.quest/v1"));
  assert.throws(() => assertTrustedExecutionApi("0x", "https://example.com"), /kaynağı doğrulanamadı/i);
});

test("0x native alımında dinamik Settler kabul edilir", () => {
  assert.doesNotThrow(() => assertExecutionContractPolicy({
    provider: "0x",
    sellToken: nativeToken,
    transactionTarget: getAddress("0x0000000000000000000000000000000000000099"),
    allowanceSpender: null,
  }));
});

test("0x ERC-20 izni yalnızca resmî AllowanceHolder'a verilir", () => {
  assert.doesNotThrow(() => assertExecutionContractPolicy({
    provider: "0x",
    sellToken: buyToken,
    transactionTarget: ZERO_EX_ALLOWANCE_HOLDER,
    allowanceSpender: ZERO_EX_ALLOWANCE_HOLDER,
  }));
  assert.throws(() => assertExecutionContractPolicy({
    provider: "0x",
    sellToken: buyToken,
    transactionTarget: ZERO_EX_ALLOWANCE_HOLDER,
    allowanceSpender: getAddress("0x0000000000000000000000000000000000000099"),
  }), /AllowanceHolder/i);
});

test("LI.FI yalnızca resmî Diamond hedefini kabul eder", () => {
  assert.throws(() => assertExecutionContractPolicy({
    provider: "lifi",
    sellToken: nativeToken,
    transactionTarget: getAddress("0x0000000000000000000000000000000000000099"),
    allowanceSpender: null,
  }), /Diamond/i);
});

test("Uniswap V2 fallback yalnızca resmî Base Router02 hedefini kabul eder", () => {
  assert.doesNotThrow(() => assertExecutionContractPolicy({
    provider: "uniswap-v2",
    sellToken: buyToken,
    transactionTarget: BASE_UNISWAP_V2_ROUTER,
    allowanceSpender: BASE_UNISWAP_V2_ROUTER,
  }));
  assert.throws(() => assertExecutionContractPolicy({
    provider: "uniswap-v2",
    sellToken: buyToken,
    transactionTarget: getAddress("0x0000000000000000000000000000000000000099"),
    allowanceSpender: BASE_UNISWAP_V2_ROUTER,
  }), /Router02/i);
});

test("Uniswap V3 fallback yalnızca resmî Base SwapRouter02 hedefini kabul eder", () => {
  assert.doesNotThrow(() => assertExecutionContractPolicy({
    provider: "uniswap-v3",
    sellToken: nativeToken,
    transactionTarget: BASE_UNISWAP_V3_ROUTER,
    allowanceSpender: null,
  }));
  assert.throws(() => assertExecutionContractPolicy({
    provider: "uniswap-v3",
    sellToken: nativeToken,
    transactionTarget: getAddress("0x0000000000000000000000000000000000000099"),
    allowanceSpender: null,
  }), /SwapRouter02/i);
});
