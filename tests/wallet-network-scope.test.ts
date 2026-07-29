import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveWalletChainIds,
  favoriteWalletChainIds,
  parseTrackedChainIds,
  walletTracksChain,
  walletTracksEffectiveChain,
} from "../src/lib/engine/wallet-network-scope.ts";

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

test("yıldızlı EVM cüzdanı bütün EVM uyumlu ağlarda izlenir", () => {
  const wallet = {
    address: "0x1111111111111111111111111111111111111111",
    isFavorite: true,
    trackedChainIds: ["base"] as const,
  };

  assert.deepEqual(favoriteWalletChainIds(wallet.address), ["ethereum", "base", "robinhood", "hyperliquid"]);
  assert.equal(walletTracksEffectiveChain(wallet, "ethereum"), true);
  assert.equal(walletTracksEffectiveChain(wallet, "robinhood"), true);
  assert.equal(walletTracksEffectiveChain(wallet, "hyperliquid"), true);
  assert.equal(walletTracksEffectiveChain(wallet, "solana"), false);
});

test("yıldızlı Solana cüzdanı yalnızca adres formatıyla uyumlu Solana ağında izlenir", () => {
  const wallet = {
    address: "2R5JTvzc2d7SE4JvNTRzCMD7ETt4Z9Ngcsp7DreyPHNX2",
    isFavorite: true,
    trackedChainIds: ["solana"] as const,
  };

  assert.deepEqual(effectiveWalletChainIds(wallet), ["solana"]);
  assert.equal(walletTracksEffectiveChain(wallet, "solana"), true);
  assert.equal(walletTracksEffectiveChain(wallet, "base"), false);
});

test("yıldız kaldırıldığında cüzdan seçili ağ kapsamına döner", () => {
  const wallet = {
    address: "0x2222222222222222222222222222222222222222",
    isFavorite: false,
    trackedChainIds: ["base"] as const,
  };

  assert.deepEqual(effectiveWalletChainIds(wallet), ["base"]);
  assert.equal(walletTracksEffectiveChain(wallet, "base"), true);
  assert.equal(walletTracksEffectiveChain(wallet, "ethereum"), false);
});
