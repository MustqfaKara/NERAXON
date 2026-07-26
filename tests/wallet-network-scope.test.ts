import assert from "node:assert/strict";
import test from "node:test";
import { parseTrackedChainIds, walletTracksChain } from "../src/lib/engine/wallet-network-scope.ts";

test("tek ağ için eklenen cüzdan yalnızca o ağda eşleşir", () => {
  const trackedChainIds = parseTrackedChainIds('["base"]');

  assert.equal(walletTracksChain(trackedChainIds, "base"), true);
  assert.equal(walletTracksChain(trackedChainIds, "ethereum"), false);
});

test("aynı cüzdan birden fazla seçili ağda izlenebilir", () => {
  const trackedChainIds = parseTrackedChainIds('["base","hyperliquid","base"]');

  assert.deepEqual(trackedChainIds, ["base", "hyperliquid"]);
  assert.equal(walletTracksChain(trackedChainIds, "hyperliquid"), true);
  assert.equal(walletTracksChain(trackedChainIds, "robinhood"), false);
});

test("bozuk veya desteklenmeyen ağ verisi izleme kapsamına alınmaz", () => {
  assert.deepEqual(parseTrackedChainIds("bozuk"), []);
  assert.deepEqual(parseTrackedChainIds('["base","unknown"]'), ["base"]);
});
