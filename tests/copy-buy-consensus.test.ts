import test from "node:test";
import assert from "node:assert/strict";
import { canTriggerNextBuy, requiredWalletCountForNextBuy } from "../src/lib/engine/copy-buy-consensus.ts";

test("alım eşikleri 1, 3, 7 ve 15 farklı cüzdan olarak ilerler", () => {
  assert.deepEqual([0, 1, 2, 3].map(requiredWalletCountForNextBuy), [1, 3, 7, 15]);
});

test("ikinci alımı üçüncü farklı cüzdan tetikler", () => {
  assert.equal(canTriggerNextBuy({ completedBuyStages: 1, distinctWalletCount: 2, isNewWallet: true, hasPendingStage: false }).shouldCopy, false);
  assert.equal(canTriggerNextBuy({ completedBuyStages: 1, distinctWalletCount: 3, isNewWallet: true, hasPendingStage: false }).shouldCopy, true);
});

test("aynı cüzdan tekrar sayılmaz ve bekleyen aşama çift alımı engeller", () => {
  assert.equal(canTriggerNextBuy({ completedBuyStages: 1, distinctWalletCount: 3, isNewWallet: false, hasPendingStage: false }).shouldCopy, false);
  assert.equal(canTriggerNextBuy({ completedBuyStages: 1, distinctWalletCount: 4, isNewWallet: true, hasPendingStage: true }).shouldCopy, false);
});
