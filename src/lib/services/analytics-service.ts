import type { ConsensusEntry, PerformanceAnalytics, PerformanceSlice } from "@/lib/domain/types";
import { getDatabase } from "@/lib/repositories/database";
import { store } from "@/lib/repositories/store";
import { deriveTradeOutcomes, type AnalyticsTrade } from "@/lib/engine/trade-outcomes";

export function getPerformanceAnalytics(): PerformanceAnalytics {
  const trades = deriveTradeOutcomes(store.listAllTrades().filter((trade) => trade.status === "confirmed"));
  const startingBalance = store.getStartingBalance();
  let equity = startingBalance;
  let peak = equity;
  let maxDrawdownPercent = 0;
  const equityCurve = [{ at: trades[0]?.createdAt ?? new Date().toISOString(), valueUsd: startingBalance }];
  for (const trade of trades) {
    equity += trade.derivedRealizedPnlUsd;
    peak = Math.max(peak, equity);
    maxDrawdownPercent = Math.max(maxDrawdownPercent, peak ? ((peak - equity) / peak) * 100 : 0);
    equityCurve.push({ at: trade.createdAt, valueUsd: Number(equity.toFixed(4)) });
  }
  const sells = trades.filter((trade) => trade.hasRealizedOutcome);
  const grossProfit = sum(sells.filter((trade) => trade.derivedRealizedPnlUsd > 0), (trade) => trade.derivedRealizedPnlUsd);
  const grossLoss = Math.abs(sum(sells.filter((trade) => trade.derivedRealizedPnlUsd < 0), (trade) => trade.derivedRealizedPnlUsd));
  return {
    confirmedTrades: trades.length,
    winRate: sells.length ? round(sells.filter((trade) => trade.derivedRealizedPnlUsd > 0).length / sells.length * 100) : 0,
    profitFactor: grossLoss ? round(grossProfit / grossLoss) : grossProfit > 0 ? grossProfit : 0,
    maxDrawdownPercent: round(maxDrawdownPercent),
    averageExecutionDelayMs: trades.length ? Math.round(sum(trades, (trade) => trade.executionDelayMs) / trades.length) : 0,
    byChain: groupTrades(trades, (trade) => trade.chainId, (key) => key === "base" ? "Base" : "Ethereum"),
    byWallet: groupTrades(trades.filter((trade) => trade.walletId), (trade) => trade.walletId!, (key) => store.getWallet(key)?.label ?? "Silinmiş cüzdan"),
    byToken: groupTrades(trades, (trade) => `${trade.chainId}:${trade.tokenAddress}`, (_, rows) => rows[0].tokenSymbol),
    equityCurve,
  };
}

export function getConsensusEntries(): ConsensusEntry[] {
  const rows = getDatabase().prepare(`
    SELECT c.chain_id, c.token_address, c.copied_stages, c.updated_at,
      COUNT(s.wallet_id) AS wallet_count,
      GROUP_CONCAT(COALESCE(w.label, s.wallet_id), '|||') AS wallet_labels,
      COALESCE(p.token_symbol, 'TOKEN') AS token_symbol, p.pair_address
    FROM copy_buy_consensus c
    LEFT JOIN copy_buy_signals s ON s.chain_id = c.chain_id AND s.token_address = c.token_address
    LEFT JOIN wallets w ON w.id = s.wallet_id
    LEFT JOIN positions p ON p.chain_id = c.chain_id AND LOWER(p.token_address) = c.token_address
    GROUP BY c.chain_id, c.token_address
    ORDER BY c.updated_at DESC
  `).all() as Array<Record<string, string | number | null>>;
  const thresholds = [1, 3, 7, 15];
  return rows.map((row) => ({
    chainId: row.chain_id as ConsensusEntry["chainId"], tokenAddress: String(row.token_address),
    tokenSymbol: String(row.token_symbol), pairAddress: row.pair_address ? String(row.pair_address) : null,
    walletCount: Number(row.wallet_count), walletLabels: row.wallet_labels ? String(row.wallet_labels).split("|||") : [],
    copiedStages: Number(row.copied_stages), nextThreshold: thresholds[Number(row.copied_stages)] ?? null,
    updatedAt: String(row.updated_at),
  }));
}

function groupTrades(trades: AnalyticsTrade[], keyFor: (trade: AnalyticsTrade) => string, labelFor: (key: string, rows: AnalyticsTrade[]) => string): PerformanceSlice[] {
  const groups = new Map<string, AnalyticsTrade[]>();
  for (const trade of trades) groups.set(keyFor(trade), [...(groups.get(keyFor(trade)) ?? []), trade]);
  return [...groups.entries()].map(([key, rows]) => {
    const sells = rows.filter((trade) => trade.hasRealizedOutcome);
    const winCount = sells.filter((trade) => trade.derivedRealizedPnlUsd > 0).length;
    return { key, label: labelFor(key, rows), tradeCount: rows.length, winCount, winRate: sells.length ? round(winCount / sells.length * 100) : 0, realizedPnlUsd: round(sum(rows, (trade) => trade.derivedRealizedPnlUsd)), feesUsd: round(sum(rows, (trade) => trade.fees.totalUsd)), averageExecutionDelayMs: Math.round(sum(rows, (trade) => trade.executionDelayMs) / rows.length) };
  }).sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd);
}
const sum = <T,>(rows: T[], value: (row: T) => number) => rows.reduce((total, row) => total + value(row), 0);
const round = (value: number) => Number(value.toFixed(2));
