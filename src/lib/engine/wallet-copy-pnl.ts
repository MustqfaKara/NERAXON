export interface WalletCopyPnlLot {
  wallet_id: string;
  buy_cost_usd: number;
  sell_proceeds_usd: number;
  remaining_quantity: number;
  current_price_usd: number;
}

export function calculateWalletCopyPnl(lots: WalletCopyPnlLot[]): Map<string, number> {
  const pnlByWallet = new Map<string, number>();
  for (const lot of lots) {
    const openValueUsd = Math.max(0, lot.remaining_quantity) * Math.max(0, lot.current_price_usd);
    const netPnlUsd = lot.sell_proceeds_usd + openValueUsd - lot.buy_cost_usd;
    pnlByWallet.set(lot.wallet_id, (pnlByWallet.get(lot.wallet_id) ?? 0) + netPnlUsd);
  }
  return pnlByWallet;
}
