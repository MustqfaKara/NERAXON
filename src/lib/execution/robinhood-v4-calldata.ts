import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, type Address, type Hex } from "viem";
import type { TradeSide } from "../domain/types.ts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const UNIVERSAL_ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904" as Address;
const V4_SWAP_COMMAND = "0x10" as Hex;
const SWAP_EXACT_IN_SINGLE = 0x06;
const SETTLE_ALL = 0x0c;
const TAKE_ALL = 0x0f;
const ROUTER_ABI = parseAbi(["function execute(bytes commands,bytes[] inputs,uint256 deadline) payable"]);
const V4_SWAP_PARAMS = parseAbiParameters(
  "((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)",
);
const CURRENCY_AMOUNT_PARAMS = parseAbiParameters("address currency,uint256 amount");

export interface RobinhoodPoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export function buildRouterTransaction(poolKey: RobinhoodPoolKey, zeroForOne: boolean, sellAmount: bigint, minBuyAmount: bigint, side: TradeSide) {
  const tokenAddress = poolKey.currency0 === ZERO_ADDRESS ? poolKey.currency1 : poolKey.currency0;
  const inputCurrency = side === "buy" ? ZERO_ADDRESS : tokenAddress;
  const outputCurrency = side === "buy" ? tokenAddress : ZERO_ADDRESS;
  const actions = (`0x${[SWAP_EXACT_IN_SINGLE, TAKE_ALL, SETTLE_ALL].map((value) => value.toString(16).padStart(2, "0")).join("")}`) as Hex;
  const params: Hex[] = [
    encodeAbiParameters(V4_SWAP_PARAMS, [{ poolKey, zeroForOne, amountIn: sellAmount, amountOutMinimum: minBuyAmount, minHopPriceX36: 0n, hookData: "0x" }]),
    encodeAbiParameters(CURRENCY_AMOUNT_PARAMS, [outputCurrency, minBuyAmount]),
    encodeAbiParameters(CURRENCY_AMOUNT_PARAMS, [inputCurrency, sellAmount]),
  ];
  const v4Input = encodeAbiParameters(parseAbiParameters("bytes actions,bytes[] params"), [actions, params]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 5 * 60);
  return {
    to: UNIVERSAL_ROUTER,
    data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "execute", args: [V4_SWAP_COMMAND, [v4Input], deadline] }),
    value: side === "buy" ? sellAmount : 0n,
  };
}
