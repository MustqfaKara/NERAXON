import assert from "node:assert/strict";
import test from "node:test";
import { areOnlyStablecoinMovements, isStablecoinAsset, isStablecoinSymbol } from "../src/lib/engine/stablecoin-filter.ts";

test("yaygın stablecoin sembollerini işlem dışı bırakır", () => {
  assert.equal(isStablecoinSymbol("USDC"), true);
  assert.equal(isStablecoinSymbol("usdt"), true);
  assert.equal(isStablecoinSymbol("USDC.e"), true);
  assert.equal(isStablecoinSymbol("DAI"), true);
  assert.equal(isStablecoinSymbol("USDG"), true);
});

test("normal token sembollerini stablecoin saymaz", () => {
  assert.equal(isStablecoinSymbol("ETH"), false);
  assert.equal(isStablecoinSymbol("DEGEN"), false);
});

test("bilinen stablecoin kontratını sembolden bağımsız tanır", () => {
  assert.equal(isStablecoinAsset("base", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "UNKNOWN"), true);
  assert.equal(isStablecoinAsset("solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "UNKNOWN"), true);
  assert.equal(isStablecoinAsset("solana", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "UNKNOWN"), true);
  assert.equal(isStablecoinAsset("ethereum", "0x0000000000000000000000000000000000000001", "TOKEN"), false);
});

test("yalnızca stablecoin içeren EVM hareketlerini bildirim dışı bırakır", () => {
  assert.equal(areOnlyStablecoinMovements("robinhood", [
    { tokenAddress: "0x5fc5d1c9f3de9f225cd12e695b42e3bacc7d1680", tokenSymbol: "USDG" },
  ]), true);
  assert.equal(areOnlyStablecoinMovements("robinhood", [
    { tokenAddress: "0x5fc5d1c9f3de9f225cd12e695b42e3bacc7d1680", tokenSymbol: "USDG" },
    { tokenAddress: "0x0000000000000000000000000000000000000001", tokenSymbol: "ROAR" },
  ]), false);
});
