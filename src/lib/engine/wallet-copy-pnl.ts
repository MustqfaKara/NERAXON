import type { HypercorePaperPosition, HypercorePaperTrade } from "@/lib/domain/types";

export interface WalletCopyPnlLot {
  wallet_id: string;
  buy_cost_usd: number;
  sell_proceeds_usd: number;
  remaining_quantity: number;
  current_price_usd: number;
}

const HYPERCORE_ENTRY_ACTIONS = new Set<HypercorePaperTrade["action"]>(["open", "increase", "spot_buy"]);

export function calculateWalletCopyPnl(lots: WalletCopyPnlLot[]): Map<string, number> {
  const pnlByWallet = new Map<string, number>();
  for (const lot of lots) {
    const openValueUsd = Math.max(0, lot.remaining_quantity) * Math.max(0, lot.current_price_usd);
    const netPnlUsd = lot.sell_proceeds_usd + openValueUsd - lot.buy_cost_usd;
    pnlByWallet.set(lot.wallet_id, (pnlByWallet.get(lot.wallet_id) ?? 0) + netPnlUsd);
  }
  return pnlByWallet;
}

export function calculateHypercoreWalletCopyPnl(
  trades: HypercorePaperTrade[],
  positions: HypercorePaperPosition[],
): Map<string, number> {
  const pnlByWallet = new Map<string, number>();
  for (const trade of trades) {
    if (trade.status !== "confirmed" || !trade.walletId) continue;
    const entryFeeUsd = trade.source === "copy" && HYPERCORE_ENTRY_ACTIONS.has(trade.action) ? trade.feeUsd : 0;
    const netPnlUsd = trade.realizedPnlUsd - entryFeeUsd - trade.fundingUsd;
    pnlByWallet.set(trade.walletId, (pnlByWallet.get(trade.walletId) ?? 0) + netPnlUsd);
  }
  for (const position of positions) {
    if (!position.walletId) continue;
    const openPnlUsd = position.unrealizedPnlUsd - position.fundingUsd;
    pnlByWallet.set(position.walletId, (pnlByWallet.get(position.walletId) ?? 0) + openPnlUsd);
  }
  return pnlByWallet;
}
