import test from "node:test";
import assert from "node:assert/strict";
import { calculateWalletCopyPnl } from "../src/lib/engine/wallet-copy-pnl.ts";

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
