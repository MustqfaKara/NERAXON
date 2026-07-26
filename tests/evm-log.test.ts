import test from "node:test";
import assert from "node:assert/strict";
import { parseErc20TransferAmount } from "../src/lib/chains/evm-log.ts";

test("boş EVM log verisini sıfır miktar olarak işler", () => {
  assert.equal(parseErc20TransferAmount(undefined), 0n);
  assert.equal(parseErc20TransferAmount("0x"), 0n);
  assert.equal(parseErc20TransferAmount(" 0X "), 0n);
});

test("geçerli ERC-20 transfer miktarını bigint olarak işler", () => {
  assert.equal(parseErc20TransferAmount("0x2a"), 42n);
});
