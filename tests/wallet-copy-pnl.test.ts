import test from "node:test";
import assert from "node:assert/strict";
import { calculateHypercoreWalletCopyPnl, calculateWalletCopyPnl } from "../src/lib/engine/wallet-copy-pnl.ts";
import type { HypercorePaperPosition, HypercorePaperTrade } from "../src/lib/domain/types.ts";

test("açık copy pozisyonunu güncel fiyatla cüzdan PnL hesabına katar", () => {
  const result = calculateWalletCopyPnl([{
    wallet_id: "wallet-a",
    buy_cost_usd: 10,
    sell_proceeds_usd: 0,
    remaining_quantity: 5,
    current_price_usd: 2.2,
  }]);

  assert.equal(result.get("wallet-a"), 1);
});

test("satış geliri ve kalan miktarı aynı cüzdan altında toplar", () => {
  const result = calculateWalletCopyPnl([{
    wallet_id: "wallet-a",
    buy_cost_usd: 20,
    sell_proceeds_usd: 12,
    remaining_quantity: 4,
    current_price_usd: 2.5,
  }]);

  assert.equal(result.get("wallet-a"), 2);
});

test("farklı token lotlarını cüzdan bazında birleştirir", () => {
  const result = calculateWalletCopyPnl([
    { wallet_id: "wallet-a", buy_cost_usd: 10, sell_proceeds_usd: 0, remaining_quantity: 6, current_price_usd: 2 },
    { wallet_id: "wallet-a", buy_cost_usd: 8, sell_proceeds_usd: 9, remaining_quantity: 0, current_price_usd: 0 },
    { wallet_id: "wallet-b", buy_cost_usd: 5, sell_proceeds_usd: 0, remaining_quantity: 5, current_price_usd: 1 },
  ]);

  assert.equal(result.get("wallet-a"), 3);
  assert.equal(result.get("wallet-b"), 0);
});

test("HyperCore net PnL giriş ücretini, güncel açık PnL değerini ve funding maliyetini içerir", () => {
  const trades = [{
    id: "trade-open", walletId: "wallet-a", source: "copy", coin: "HYPE", marketType: "perp", side: "buy",
    positionSide: "long", action: "open", quantity: 1, priceUsd: 20, notionalUsd: 20, marginUsd: 10,
    leverage: 2, feeUsd: 0.2, fundingUsd: 0.1, realizedPnlUsd: 0, status: "confirmed", reason: "test",
    sourceFillId: "fill-open", createdAt: "2026-07-15T00:00:00.000Z",
  }] satisfies HypercorePaperTrade[];
  const positions = [{
    id: "position-a", walletId: "wallet-a", walletLabel: "Wallet A", coin: "HYPE", marketType: "perp",
    side: "long", quantity: 1, entryPriceUsd: 20, currentPriceUsd: 23, marginUsd: 10, leverage: 2,
    liquidationPriceUsd: 11, unrealizedPnlUsd: 3, fundingUsd: 0.4,
    openedAt: "2026-07-15T00:00:00.000Z", updatedAt: "2026-07-15T00:01:00.000Z",
  }] satisfies HypercorePaperPosition[];

  const result = calculateHypercoreWalletCopyPnl(trades, positions);

  assert.equal(result.get("wallet-a"), 2.3);
});

test("HyperCore kapanış ücretini ikinci kez düşmez ve reddedilen işlemi yok sayar", () => {
  const baseTrade = {
    walletId: "wallet-a", source: "copy", coin: "HYPE", marketType: "perp", side: "sell", positionSide: "long",
    quantity: 1, priceUsd: 25, notionalUsd: 25, marginUsd: 10, leverage: 2, feeUsd: 0.25, fundingUsd: 0,
    reason: "test", sourceFillId: "fill-close", createdAt: "2026-07-15T00:00:00.000Z",
  } as const;
  const trades = [
    { ...baseTrade, id: "trade-close", action: "close", realizedPnlUsd: 4.75, status: "confirmed" },
    { ...baseTrade, id: "trade-skipped", action: "skipped", realizedPnlUsd: 100, status: "skipped" },
  ] satisfies HypercorePaperTrade[];

  const result = calculateHypercoreWalletCopyPnl(trades, []);

  assert.equal(result.get("wallet-a"), 4.75);
});

test("manuel kapatılan copy HyperCore pozisyonunun sonucu kaynak cüzdana yazılır", () => {
  const baseTrade = {
    id: "trade-open", walletId: "wallet-a", source: "copy", coin: "HYPE", marketType: "perp", side: "buy",
    positionSide: "long", action: "open", quantity: 1, priceUsd: 10, notionalUsd: 10, marginUsd: 5,
    leverage: 2, feeUsd: 0.2, fundingUsd: 0, realizedPnlUsd: 0, status: "confirmed", reason: "test",
    sourceFillId: "fill-open", createdAt: "2026-07-15T00:00:00.000Z",
  } satisfies HypercorePaperTrade;
  const trades = [
    baseTrade,
    { ...baseTrade, id: "manual-close", source: "manual", action: "close", side: "sell", feeUsd: 0.1, realizedPnlUsd: 1.9 },
  ] satisfies HypercorePaperTrade[];

  const result = calculateHypercoreWalletCopyPnl(trades, []);

  assert.equal(result.get("wallet-a"), 1.7);
});
