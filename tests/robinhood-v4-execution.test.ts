import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData } from "viem";
import { buildRouterTransaction } from "../src/lib/execution/robinhood-v4-calldata.ts";

const routerAbi = [{
  type: "function",
  name: "execute",
  stateMutability: "payable",
  inputs: [
    { name: "commands", type: "bytes" },
    { name: "inputs", type: "bytes[]" },
    { name: "deadline", type: "uint256" },
  ],
  outputs: [],
}] as const;

const token = "0x1111111111111111111111111111111111111111";
const poolKey = {
  currency0: "0x0000000000000000000000000000000000000000",
  currency1: token,
  fee: 50_000,
  tickSpacing: 1_000,
  hooks: "0x0000000000000000000000000000000000000000",
} as const;

test("Robinhood alımı native ETH değerini Router çağrısına ekler", () => {
  const transaction = buildRouterTransaction(poolKey, true, 1_000n, 900n, "buy");
  const decoded = decodeFunctionData({ abi: routerAbi, data: transaction.data });
  assert.equal(transaction.value, 1_000n);
  assert.equal(decoded.functionName, "execute");
  assert.equal(decoded.args[0], "0x10");
  assert.equal(decoded.args[1].length, 1);
});

test("Robinhood satışı Router'a native değer göndermez", () => {
  const transaction = buildRouterTransaction(poolKey, false, 1_000n, 900n, "sell");
  assert.equal(transaction.value, 0n);
});
