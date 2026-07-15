import { getDatabase, getSetting, setSetting } from "@/lib/repositories/database";
import { DEFAULT_RISK_SETTINGS } from "@/lib/domain/defaults";
import { calculateWalletScore } from "@/lib/engine/wallet-scoring";
import { calculateWalletCopyPnl, type WalletCopyPnlLot } from "@/lib/engine/wallet-copy-pnl";
import { canTriggerNextBuy } from "@/lib/engine/copy-buy-consensus";
import { evaluateWalletActivityLimit } from "@/lib/engine/wallet-activity-limit";
import { mapChain, mapEvent, mapPosition, mapPositionLot, mapTrade, mapWallet } from "@/lib/repositories/mappers";
import type {
  AuditEvent,
  ActivityType,
  ChainId,
  ChainRuntime,
  CircuitBreakerState,
  Position,
  PositionLot,
  RiskSettings,
  Trade,
  TrackedWallet,
  TradingMode,
  AppLanguage,
} from "@/lib/domain/types";

export const store = {
  listChains(): ChainRuntime[] {
    return (getDatabase().prepare("SELECT * FROM chains ORDER BY id").all() as Record<string, unknown>[]).map(mapChain);
  },

  getChain(chainId: ChainId): ChainRuntime | null {
    const row = getDatabase().prepare("SELECT * FROM chains WHERE id = ?").get(chainId) as Record<string, unknown> | undefined;
    return row ? mapChain(row) : null;
  },

  updateChain(chainId: ChainId, update: Partial<ChainRuntime>) {
    const current = this.getChain(chainId);
    if (!current) throw new Error("Ağ bulunamadı.");
    const next = { ...current, ...update, updatedAt: new Date().toISOString() };
    getDatabase().prepare(`
      UPDATE chains SET status = ?, rpc_configured = ?, last_block = ?, latency_ms = ?, error_message = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.status,
      next.rpcConfigured ? 1 : 0,
      next.lastBlock,
      next.latencyMs,
      next.errorMessage,
      next.updatedAt,
      chainId,
    );
    return next;
  },

  listWallets(): TrackedWallet[] {
    const database = getDatabase();
    const pnlLots = database.prepare(`
      SELECT
        position_lots.wallet_id AS wallet_id,
        SUM(position_lots.entry_cost_usd) AS buy_cost_usd,
        SUM(position_lots.entry_cost_usd + position_lots.realized_pnl_usd - (position_lots.entry_cost_usd * position_lots.remaining_quantity / position_lots.initial_quantity)) AS sell_proceeds_usd,
        SUM(position_lots.remaining_quantity) AS remaining_quantity,
        COALESCE(positions.current_price_usd, 0) AS current_price_usd
      FROM position_lots
      LEFT JOIN positions
        ON positions.chain_id = position_lots.chain_id
        AND LOWER(positions.token_address) = LOWER(position_lots.token_address)
      WHERE position_lots.source = 'copy' AND position_lots.wallet_id IS NOT NULL
      GROUP BY position_lots.wallet_id, position_lots.chain_id, LOWER(position_lots.token_address)
    `).all() as unknown as WalletCopyPnlLot[];
    const pnlByWallet = calculateWalletCopyPnl(pnlLots);
    return (database.prepare(`
      SELECT wallets.*, COALESCE(copy_counts.copied_trade_count, 0) AS copied_trade_count
      FROM wallets
      LEFT JOIN (
        SELECT wallet_id, COUNT(*) AS copied_trade_count
        FROM trades
        WHERE source = 'copy' AND status = 'confirmed' AND wallet_id IS NOT NULL
        GROUP BY wallet_id
      ) AS copy_counts ON copy_counts.wallet_id = wallets.id
      ORDER BY wallets.score DESC, wallets.created_at DESC
    `).all() as Record<string, unknown>[])
      .map(mapWallet)
      .map((wallet) => {
        const copiedTrades = (database.prepare(`
          SELECT * FROM trades WHERE wallet_id = ? AND source = 'copy' ORDER BY created_at ASC
        `).all(wallet.id) as Record<string, unknown>[]).map(mapTrade);
        const confirmed = copiedTrades.filter((trade) => trade.status === "confirmed");
        const sells = confirmed.filter((trade) => trade.side === "sell");
        const wins = sells.filter((trade) => trade.realizedPnlUsd > 0).length;
        const copyPnlUsd = pnlByWallet.get(wallet.id) ?? 0;
        const investedUsd = pnlLots.filter((lot) => lot.wallet_id === wallet.id).reduce((sum, lot) => sum + Number(lot.buy_cost_usd), 0);
        const dynamic = calculateWalletScore({
          totalTrades: confirmed.length,
          winRate: sells.length ? wins / sells.length : 0.5,
          realizedPnlPercent: investedUsd ? copyPnlUsd / investedUsd * 100 : 0,
          maxDrawdownPercent: wallet.maxDrawdownPercent,
          copyableTradeRatio: copiedTrades.length ? confirmed.length / copiedTrades.length : 0.5,
          suspiciousActivityRatio: Math.max(0, (100 - wallet.scoreBreakdown.safety) / 100),
        });
        const evidenceWeight = Math.min(1, confirmed.length / 10);
        const blend = (observed: number, calculated: number) => Math.round(observed * (1 - evidenceWeight) + calculated * evidenceWeight);
        const scoreBreakdown = {
          profitability: blend(wallet.scoreBreakdown.profitability, dynamic.breakdown.profitability),
          consistency: blend(wallet.scoreBreakdown.consistency, dynamic.breakdown.consistency),
          riskControl: blend(wallet.scoreBreakdown.riskControl, dynamic.breakdown.riskControl),
          copyability: blend(wallet.scoreBreakdown.copyability, dynamic.breakdown.copyability),
          safety: blend(wallet.scoreBreakdown.safety, dynamic.breakdown.safety),
        };
        const score = Math.round(scoreBreakdown.profitability * .25 + scoreBreakdown.consistency * .2 + scoreBreakdown.riskControl * .2 + scoreBreakdown.copyability * .2 + scoreBreakdown.safety * .15);
        return { ...wallet, score, scoreBreakdown, winRate: sells.length ? wins / sells.length * 100 : wallet.winRate, realizedPnlUsd: copyPnlUsd };
      })
      .sort((left, right) => {
        const pausedOrder = Number(left.state === "paused") - Number(right.state === "paused");
        return pausedOrder || right.score - left.score || right.updatedAt.localeCompare(left.updatedAt);
      });
  },

  listActiveWalletAddresses(): string[] {
    return (getDatabase().prepare("SELECT address FROM wallets WHERE state != 'paused'").all() as Array<{ address: string }>)
      .map((row) => row.address.toLowerCase());
  },

  repairLegacyDiscoveryScores() {
    const rows = getDatabase().prepare(`
      SELECT id, label FROM wallets
      WHERE score = 50 AND total_trades = 0 AND label LIKE '%keşif · %'
    `).all() as Array<{ id: string; label: string }>;
    const update = getDatabase().prepare("UPDATE wallets SET score = ?, score_breakdown = ? WHERE id = ?");
    for (const row of rows) {
      const match = row.label.match(/keşif · (\d{1,3})$/u);
      if (!match) continue;
      const score = clampScore(Number(match[1]));
      const breakdown = {
        profitability: score,
        consistency: score,
        riskControl: score,
        copyability: score,
        safety: score,
      };
      update.run(score, JSON.stringify(breakdown), row.id);
    }
  },

  findWalletByAddress(address: string): TrackedWallet | null {
    return this.listWallets().find((wallet) => wallet.address === address.toLowerCase()) ?? null;
  },

  getWallet(walletId: string): TrackedWallet | null {
    const row = getDatabase().prepare("SELECT * FROM wallets WHERE id = ?").get(walletId) as Record<string, unknown> | undefined;
    return row ? mapWallet(row) : null;
  },

  insertWallet(wallet: TrackedWallet) {
    getDatabase().prepare(`
      INSERT INTO wallets
      (id, address, label, state, score, score_breakdown, total_trades, observation_swap_count, win_rate, realized_pnl_usd, max_drawdown_percent, average_hold_minutes, pause_reason, addition_context, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      wallet.id,
      wallet.address.toLowerCase(),
      wallet.label,
      wallet.state,
      wallet.score,
      JSON.stringify(wallet.scoreBreakdown),
      wallet.totalTrades,
      wallet.observationSwapCount,
      wallet.winRate,
      wallet.realizedPnlUsd,
      wallet.maxDrawdownPercent,
      wallet.averageHoldMinutes,
      wallet.pauseReason,
      JSON.stringify(wallet.additionContext),
      wallet.createdAt,
      wallet.updatedAt,
    );
    return wallet;
  },

  recordWalletObservation(walletId: string, activity: ActivityType, copied: boolean) {
    const row = getDatabase().prepare("SELECT * FROM wallets WHERE id = ?").get(walletId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const wallet = mapWallet(row);
    const breakdown = { ...wallet.scoreBreakdown };
    let totalTrades = wallet.totalTrades;
    let observationSwapCount = wallet.observationSwapCount;

    if (activity === "swap") {
      totalTrades += 1;
      if (wallet.state === "observing") observationSwapCount += 1;
      breakdown.consistency = clampScore(breakdown.consistency + (copied ? 1 : 0));
      breakdown.copyability = clampScore(breakdown.copyability + (copied ? 2 : -1));
    } else if (activity === "liquidity_remove") {
      breakdown.safety = clampScore(breakdown.safety - 5);
      breakdown.riskControl = clampScore(breakdown.riskControl - 3);
    } else if (activity === "unknown") {
      breakdown.safety = clampScore(breakdown.safety - 1);
    }

    const score = Math.round(
      breakdown.profitability * 0.25 +
      breakdown.consistency * 0.2 +
      breakdown.riskControl * 0.2 +
      breakdown.copyability * 0.2 +
      breakdown.safety * 0.15,
    );
    const state = wallet.state === "paused"
      ? "paused"
      : totalTrades >= 10 && score >= 55 ? "active" : "observing";
    const updatedAt = new Date().toISOString();
    getDatabase().prepare(`
      UPDATE wallets
      SET state = ?, score = ?, score_breakdown = ?, total_trades = ?, observation_swap_count = ?, updated_at = ?
      WHERE id = ?
    `).run(state, score, JSON.stringify(breakdown), totalTrades, observationSwapCount, updatedAt, walletId);
    return { ...wallet, state, score, scoreBreakdown: breakdown, totalTrades, observationSwapCount, updatedAt };
  },

  recordWalletSwapActivity(chainId: ChainId, walletId: string, txHash: string, observedAt = new Date().toISOString()) {
    const database = getDatabase();
    database.prepare(`
      INSERT OR IGNORE INTO wallet_swap_activity (chain_id, wallet_id, tx_hash, observed_at)
      VALUES (?, ?, ?, ?)
    `).run(chainId, walletId, txHash.toLowerCase(), observedAt);

    const observedTime = new Date(observedAt).getTime();
    const hourStart = new Date(observedTime - 60 * 60 * 1_000).toISOString();
    const dayStart = new Date(observedTime - 24 * 60 * 60 * 1_000).toISOString();
    const counts = database.prepare(`
      SELECT
        SUM(CASE WHEN observed_at >= ? THEN 1 ELSE 0 END) AS hour_count,
        COUNT(*) AS day_count
      FROM wallet_swap_activity
      WHERE wallet_id = ? AND observed_at >= ?
    `).get(hourStart, walletId, dayStart) as { hour_count: number | null; day_count: number };
    const settings = this.getRiskSettings();
    const swapsLastHour = Number(counts.hour_count ?? 0);
    const swapsLast24Hours = Number(counts.day_count ?? 0);
    const decision = evaluateWalletActivityLimit({
      swapsLastHour,
      swapsLast24Hours,
      maxSwapsPerHour: settings.maxWalletSwapsPerHour ?? 8,
      maxSwapsPer24Hours: settings.maxWalletSwapsPer24Hours ?? 25,
    });
    const wallet = this.getWallet(walletId);
    const newlyPaused = Boolean(decision.exceeded && wallet && wallet.state !== "paused");
    if (newlyPaused) {
      database.prepare("UPDATE wallets SET state = 'paused', pause_reason = ?, updated_at = ? WHERE id = ?")
        .run(decision.reason, observedAt, walletId);
    }
    return { ...decision, newlyPaused, swapsLastHour, swapsLast24Hours };
  },

  pauseOveractiveWallets(observedAt = new Date().toISOString()) {
    const database = getDatabase();
    const observedTime = new Date(observedAt).getTime();
    const hourStart = new Date(observedTime - 60 * 60 * 1_000).toISOString();
    const dayStart = new Date(observedTime - 24 * 60 * 60 * 1_000).toISOString();
    const settings = this.getRiskSettings();
    const wallets = database.prepare("SELECT id, label FROM wallets WHERE state != 'paused'").all() as Array<{ id: string; label: string }>;
    const countQuery = database.prepare(`
      SELECT
        SUM(CASE WHEN observed_at >= ? THEN 1 ELSE 0 END) AS hour_count,
        COUNT(*) AS day_count
      FROM wallet_swap_activity
      WHERE wallet_id = ? AND observed_at >= ?
    `);
    const paused: Array<{ id: string; label: string; reason: string; swapsLastHour: number; swapsLast24Hours: number }> = [];
    for (const wallet of wallets) {
      const counts = countQuery.get(hourStart, wallet.id, dayStart) as { hour_count: number | null; day_count: number };
      const swapsLastHour = Number(counts.hour_count ?? 0);
      const swapsLast24Hours = Number(counts.day_count ?? 0);
      const decision = evaluateWalletActivityLimit({
        swapsLastHour,
        swapsLast24Hours,
        maxSwapsPerHour: settings.maxWalletSwapsPerHour ?? 8,
        maxSwapsPer24Hours: settings.maxWalletSwapsPer24Hours ?? 25,
      });
      if (!decision.exceeded || !decision.reason) continue;
      database.prepare("UPDATE wallets SET state = 'paused', pause_reason = ?, updated_at = ? WHERE id = ?")
        .run(decision.reason, observedAt, wallet.id);
      paused.push({ id: wallet.id, label: wallet.label, reason: decision.reason, swapsLastHour, swapsLast24Hours });
    }
    return paused;
  },

  registerCopyBuySignal(chainId: ChainId, tokenAddress: string, walletId: string, txHash?: string) {
    const database = getDatabase();
    const normalizedAddress = tokenAddress.toLowerCase();
    const now = new Date().toISOString();
    const inserted = database.prepare(`
      INSERT OR IGNORE INTO copy_buy_signals
      (chain_id, token_address, wallet_id, first_tx_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(chainId, normalizedAddress, walletId, txHash?.toLowerCase() ?? null, now);
    database.prepare(`
      INSERT OR IGNORE INTO copy_buy_consensus
      (chain_id, token_address, copied_stages, pending_stage, updated_at)
      VALUES (?, ?, 0, NULL, ?)
    `).run(chainId, normalizedAddress, now);

    const signalRow = database.prepare(`
      SELECT COUNT(*) AS count FROM copy_buy_signals
      WHERE chain_id = ? AND token_address = ?
    `).get(chainId, normalizedAddress) as { count: number };
    const state = database.prepare(`
      SELECT copied_stages, pending_stage FROM copy_buy_consensus
      WHERE chain_id = ? AND token_address = ?
    `).get(chainId, normalizedAddress) as { copied_stages: number; pending_stage: number | null };
    const decision = canTriggerNextBuy({
      completedBuyStages: state.copied_stages,
      distinctWalletCount: Number(signalRow.count),
      isNewWallet: inserted.changes > 0,
      hasPendingStage: state.pending_stage !== null,
    });
    const stage = state.copied_stages + 1;
    if (decision.shouldCopy) {
      database.prepare(`
        UPDATE copy_buy_consensus SET pending_stage = ?, updated_at = ?
        WHERE chain_id = ? AND token_address = ? AND pending_stage IS NULL
      `).run(stage, now, chainId, normalizedAddress);
    }
    return {
      ...decision,
      distinctWalletCount: Number(signalRow.count),
      stage,
    };
  },

  finishCopyBuyStage(chainId: ChainId, tokenAddress: string, stage: number, confirmed: boolean) {
    const normalizedAddress = tokenAddress.toLowerCase();
    const now = new Date().toISOString();
    if (confirmed) {
      getDatabase().prepare(`
        UPDATE copy_buy_consensus
        SET copied_stages = ?, pending_stage = NULL, updated_at = ?
        WHERE chain_id = ? AND token_address = ? AND pending_stage = ?
      `).run(stage, now, chainId, normalizedAddress, stage);
      return;
    }
    getDatabase().prepare(`
      UPDATE copy_buy_consensus SET pending_stage = NULL, updated_at = ?
      WHERE chain_id = ? AND token_address = ? AND pending_stage = ?
    `).run(now, chainId, normalizedAddress, stage);
  },

  setWalletPaused(walletId: string, paused: boolean) {
    const wallet = this.getWallet(walletId);
    if (!wallet) throw new Error("Cüzdan bulunamadı.");
    const state = paused ? "paused" : wallet.totalTrades >= 10 && wallet.score >= 55 ? "active" : "observing";
    const updatedAt = new Date().toISOString();
    const pauseReason = paused ? "Kullanıcı tarafından manuel olarak duraklatıldı." : null;
    getDatabase().prepare("UPDATE wallets SET state = ?, pause_reason = ?, updated_at = ? WHERE id = ?").run(state, pauseReason, updatedAt, walletId);
    return { ...wallet, state, pauseReason, updatedAt };
  },

  deleteWallet(walletId: string) {
    const wallet = this.getWallet(walletId);
    if (!wallet) throw new Error("Cüzdan bulunamadı.");
    getDatabase().prepare("DELETE FROM wallets WHERE id = ?").run(walletId);
    return wallet;
  },

  listTrades(limit = 50): Trade[] {
    return (getDatabase().prepare("SELECT * FROM trades ORDER BY created_at DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map(mapTrade);
  },

  listAllTrades(): Trade[] {
    return (getDatabase().prepare("SELECT * FROM trades ORDER BY created_at DESC").all() as Record<string, unknown>[]).map(mapTrade);
  },

  getTotalTradeFeesUsd(): number {
    const row = getDatabase().prepare(`
      SELECT COALESCE(SUM(CAST(json_extract(fees, '$.totalUsd') AS REAL)), 0) AS total
      FROM trades
      WHERE status = 'confirmed'
    `).get() as { total: number };
    return row.total;
  },

  hasConfirmedTradeForTransaction(chainId: ChainId | null, txHash: string) {
    if (!chainId) return false;
    const row = getDatabase().prepare(`
      SELECT 1 FROM trades
      WHERE chain_id = ? AND tx_hash = ? AND status = 'confirmed'
      LIMIT 1
    `).get(chainId, txHash.toLowerCase());
    return Boolean(row);
  },

  insertTrade(trade: Trade) {
    getDatabase().prepare(`
      INSERT INTO trades
      (id, chain_id, wallet_id, source, side, token_address, token_symbol, quantity, price_usd, gross_usd, net_usd, realized_pnl_usd, execution_delay_ms, status, fees, reason, tx_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trade.id,
      trade.chainId,
      trade.walletId,
      trade.source,
      trade.side,
      trade.tokenAddress.toLowerCase(),
      trade.tokenSymbol,
      trade.quantity,
      trade.priceUsd,
      trade.grossUsd,
      trade.netUsd,
      trade.realizedPnlUsd,
      trade.executionDelayMs,
      trade.status,
      JSON.stringify(trade.fees),
      trade.reason,
      trade.txHash,
      trade.createdAt,
    );
    return trade;
  },

  listPositionLots(chainId?: ChainId, tokenAddress?: string, walletId?: string | null): PositionLot[] {
    const clauses: string[] = ["remaining_quantity > 0.000000001"];
    const params: Array<string> = [];
    if (chainId) { clauses.push("chain_id = ?"); params.push(chainId); }
    if (tokenAddress) { clauses.push("token_address = ?"); params.push(tokenAddress.toLowerCase()); }
    if (walletId !== undefined) {
      if (walletId === null) clauses.push("wallet_id IS NULL");
      else { clauses.push("wallet_id = ?"); params.push(walletId); }
    }
    return (getDatabase().prepare(`
      SELECT * FROM position_lots WHERE ${clauses.join(" AND ")}
      ORDER BY opened_at ASC, id ASC
    `).all(...params) as Record<string, unknown>[]).map(mapPositionLot);
  },

  insertPositionLot(lot: PositionLot) {
    getDatabase().prepare(`
      INSERT INTO position_lots
      (id, chain_id, token_address, token_symbol, pair_address, wallet_id, wallet_label, source, opened_trade_id, initial_quantity, remaining_quantity, entry_price_usd, entry_cost_usd, realized_pnl_usd, opened_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      lot.id, lot.chainId, lot.tokenAddress.toLowerCase(), lot.tokenSymbol, lot.pairAddress,
      lot.walletId, lot.walletLabel, lot.source, lot.openedTradeId, lot.initialQuantity,
      lot.remainingQuantity, lot.entryPriceUsd, lot.entryCostUsd, lot.realizedPnlUsd,
      lot.openedAt, lot.updatedAt,
    );
    return lot;
  },

  updatePositionLot(lot: PositionLot) {
    getDatabase().prepare(`
      UPDATE position_lots
      SET remaining_quantity = ?, realized_pnl_usd = ?, updated_at = ?
      WHERE id = ?
    `).run(lot.remainingQuantity, lot.realizedPnlUsd, lot.updatedAt, lot.id);
  },

  syncPositionFromLots(chainId: ChainId, tokenAddress: string, currentPriceUsd: number, metadata?: { tokenSymbol?: string; pairAddress?: string | null }) {
    const lots = this.listPositionLots(chainId, tokenAddress);
    const existing = this.getPosition(chainId, tokenAddress);
    if (!lots.length) {
      if (existing) this.deletePosition(existing.id);
      return null;
    }
    const quantity = lots.reduce((sum, lot) => sum + lot.remainingQuantity, 0);
    const investedUsd = lots.reduce((sum, lot) => sum + lot.entryCostUsd * (lot.remainingQuantity / lot.initialQuantity), 0);
    const walletIds = [...new Set(lots.map((lot) => lot.walletId).filter((value): value is string => Boolean(value)))];
    const walletLabels = [...new Set(lots.map((lot) => lot.walletLabel).filter((value): value is string => Boolean(value)))];
    const position: Position = {
      id: existing?.id ?? crypto.randomUUID(),
      chainId,
      tokenAddress: tokenAddress.toLowerCase(),
      tokenSymbol: metadata?.tokenSymbol ?? existing?.tokenSymbol ?? lots[0].tokenSymbol,
      pairAddress: metadata?.pairAddress ?? existing?.pairAddress ?? lots[0].pairAddress,
      sourceWalletId: walletIds.length === 1 ? walletIds[0] : null,
      sourceWalletLabel: walletLabels.length === 1 ? walletLabels[0] : walletLabels.length > 1 ? `${walletLabels.length} cüzdan konsensüsü` : null,
      quantity,
      averageEntryUsd: investedUsd / quantity,
      currentPriceUsd,
      investedUsd,
      unrealizedPnlUsd: quantity * currentPriceUsd - investedUsd,
      updatedAt: new Date().toISOString(),
    };
    this.upsertPosition(position);
    return position;
  },

  listPositions(): Position[] {
    return (getDatabase().prepare("SELECT * FROM positions ORDER BY invested_usd DESC").all() as Record<string, unknown>[]).map(mapPosition);
  },

  getPosition(chainId: ChainId, tokenAddress: string): Position | null {
    const row = getDatabase().prepare("SELECT * FROM positions WHERE chain_id = ? AND token_address = ?").get(chainId, tokenAddress.toLowerCase()) as Record<string, unknown> | undefined;
    return row ? mapPosition(row) : null;
  },

  upsertPosition(position: Position) {
    getDatabase().prepare(`
      INSERT INTO positions
      (id, chain_id, token_address, token_symbol, pair_address, source_wallet_id, source_wallet_label, quantity, average_entry_usd, current_price_usd, invested_usd, unrealized_pnl_usd, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chain_id, token_address) DO UPDATE SET
        token_symbol = excluded.token_symbol,
        pair_address = COALESCE(excluded.pair_address, positions.pair_address),
        source_wallet_id = excluded.source_wallet_id,
        source_wallet_label = excluded.source_wallet_label,
        quantity = excluded.quantity,
        average_entry_usd = excluded.average_entry_usd,
        current_price_usd = excluded.current_price_usd,
        invested_usd = excluded.invested_usd,
        unrealized_pnl_usd = excluded.unrealized_pnl_usd,
        updated_at = excluded.updated_at
    `).run(
      position.id,
      position.chainId,
      position.tokenAddress.toLowerCase(),
      position.tokenSymbol,
      position.pairAddress ?? null,
      position.sourceWalletId,
      position.sourceWalletLabel,
      position.quantity,
      position.averageEntryUsd,
      position.currentPriceUsd,
      position.investedUsd,
      position.unrealizedPnlUsd,
      position.updatedAt,
    );
  },

  deletePosition(id: string) {
    getDatabase().prepare("DELETE FROM positions WHERE id = ?").run(id);
  },

  listEvents(limit = 50): AuditEvent[] {
    return (getDatabase().prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map(mapEvent);
  },

  insertEvent(event: AuditEvent) {
    getDatabase().prepare(`
      INSERT INTO events (id, chain_id, level, type, title, message, tx_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(event.id, event.chainId, event.level, event.type, event.title, event.message, event.txHash, event.createdAt);
    return event;
  },

  getMode: () => getSetting<TradingMode>("mode"),
  getLanguage: () => getSetting<AppLanguage>("language"),
  setLanguage: (value: AppLanguage) => setSetting("language", value),
  getStartingBalance: () => getSetting<number>("startingBalanceUsd"),
  getCashBalance: () => getSetting<number>("cashBalanceUsd"),
  setCashBalance: (value: number) => setSetting("cashBalanceUsd", Math.max(0, value)),
  getRiskSettings: () => ({ ...DEFAULT_RISK_SETTINGS, ...getSetting<RiskSettings>("riskSettings") }),
  setRiskSettings: (value: RiskSettings) => setSetting("riskSettings", value),
  getCircuitBreaker: () => getSetting<CircuitBreakerState>("circuitBreaker"),
  setCircuitBreaker: (value: CircuitBreakerState) => setSetting("circuitBreaker", value),
  getDailyStartDate: () => getSetting<string>("dailyStartDate"),
  setDailyStartDate: (value: string) => setSetting("dailyStartDate", value),
  getDailyStartEquity: () => getSetting<number>("dailyStartEquityUsd"),
  setDailyStartEquity: (value: number) => setSetting("dailyStartEquityUsd", value),
};

const clampScore = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
