import type { AuditEvent, ChainRuntime, Position, PositionLot, Trade, TrackedWallet } from "@/lib/domain/types";

type Row = Record<string, unknown>;

export const mapChain = (row: Row): ChainRuntime => ({
  id: row.id as ChainRuntime["id"],
  name: row.name as string,
  nativeSymbol: row.native_symbol as string,
  status: row.status as ChainRuntime["status"],
  rpcConfigured: Boolean(row.rpc_configured),
  lastBlock: row.last_block as number | null,
  latencyMs: row.latency_ms as number | null,
  errorMessage: row.error_message as string | null,
  updatedAt: row.updated_at as string,
});

export const mapWallet = (row: Row): TrackedWallet => ({
  id: row.id as string,
  address: row.address as string,
  label: row.label as string,
  state: row.state as TrackedWallet["state"],
  score: row.score as number,
  scoreBreakdown: JSON.parse(row.score_breakdown as string),
  totalTrades: row.total_trades as number,
  observationSwapCount: Number(row.observation_swap_count ?? 0),
  copiedTradeCount: Number(row.copied_trade_count ?? 0),
  winRate: row.win_rate as number,
  realizedPnlUsd: row.realized_pnl_usd as number,
  maxDrawdownPercent: row.max_drawdown_percent as number,
  averageHoldMinutes: row.average_hold_minutes as number,
  pauseReason: row.pause_reason as string | null,
  additionContext: row.addition_context ? JSON.parse(row.addition_context as string) : null,
  createdAt: row.created_at as string,
  updatedAt: row.updated_at as string,
});

export const mapTrade = (row: Row): Trade => ({
  id: row.id as string,
  chainId: row.chain_id as Trade["chainId"],
  walletId: row.wallet_id as string | null,
  source: row.source as Trade["source"],
  side: row.side as Trade["side"],
  tokenAddress: row.token_address as string,
  tokenSymbol: row.token_symbol as string,
  quantity: row.quantity as number,
  priceUsd: row.price_usd as number,
  grossUsd: row.gross_usd as number,
  netUsd: row.net_usd as number,
  realizedPnlUsd: Number(row.realized_pnl_usd ?? 0),
  executionDelayMs: Number(row.execution_delay_ms ?? 0),
  status: row.status as Trade["status"],
  fees: JSON.parse(row.fees as string),
  reason: row.reason as string,
  txHash: row.tx_hash as string | null,
  createdAt: row.created_at as string,
});

export const mapPositionLot = (row: Row): PositionLot => ({
  id: row.id as string,
  chainId: row.chain_id as PositionLot["chainId"],
  tokenAddress: row.token_address as string,
  tokenSymbol: row.token_symbol as string,
  pairAddress: row.pair_address as string | null,
  walletId: row.wallet_id as string | null,
  walletLabel: row.wallet_label as string | null,
  source: row.source as PositionLot["source"],
  openedTradeId: row.opened_trade_id as string | null,
  initialQuantity: row.initial_quantity as number,
  remainingQuantity: row.remaining_quantity as number,
  entryPriceUsd: row.entry_price_usd as number,
  entryCostUsd: row.entry_cost_usd as number,
  realizedPnlUsd: row.realized_pnl_usd as number,
  openedAt: row.opened_at as string,
  updatedAt: row.updated_at as string,
});

export const mapPosition = (row: Row): Position => ({
  id: row.id as string,
  chainId: row.chain_id as Position["chainId"],
  tokenAddress: row.token_address as string,
  tokenSymbol: row.token_symbol as string,
  pairAddress: row.pair_address as string | null,
  sourceWalletId: row.source_wallet_id as string | null,
  sourceWalletLabel: row.source_wallet_label as string | null,
  quantity: row.quantity as number,
  averageEntryUsd: row.average_entry_usd as number,
  currentPriceUsd: row.current_price_usd as number,
  investedUsd: row.invested_usd as number,
  unrealizedPnlUsd: row.unrealized_pnl_usd as number,
  updatedAt: row.updated_at as string,
});

export const mapEvent = (row: Row): AuditEvent => ({
  id: row.id as string,
  chainId: row.chain_id as AuditEvent["chainId"],
  level: row.level as AuditEvent["level"],
  type: row.type as AuditEvent["type"],
  title: row.title as string,
  message: row.message as string,
  txHash: row.tx_hash as string | null,
  createdAt: row.created_at as string,
});
