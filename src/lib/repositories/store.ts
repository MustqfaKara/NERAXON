import { getDatabase, getSetting, setSetting } from "@/lib/repositories/database";
import { PublicKey } from "@solana/web3.js";
import { DEFAULT_RISK_SETTINGS } from "@/lib/domain/defaults";
import { calculateWalletScore } from "@/lib/engine/wallet-scoring";
import { calculateHypercoreWalletCopyPnl, calculateWalletCopyPnl, type WalletCopyPnlLot } from "@/lib/engine/wallet-copy-pnl";
import { executionLotNetPnl } from "@/lib/engine/execution-wallet-performance";
import { canTriggerNextBuy } from "@/lib/engine/copy-buy-consensus";
import { evaluateWalletActivityLimit, walletActivityLimitsFor } from "@/lib/engine/wallet-activity-limit";
import { parseTrackedChainIds, walletTracksEffectiveChain } from "@/lib/engine/wallet-network-scope";
import { mapChain, mapEvent, mapHypercorePosition, mapHypercoreTrade, mapPosition, mapPositionLot, mapTrade, mapWallet } from "@/lib/repositories/mappers";
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
  HypercorePaperPosition,
  HypercorePaperTrade,
  ExecutionLot,
  ExecutionAttempt,
  ShadowAccount,
  ReconciliationRecord,
  CertificationStep,
  ExecutionAccountAddresses,
  ServiceHealthMetric,
  ShadowPortfolioSummary,
  AiTradeAdvisory,
  SocialTokenSignal,
  TelegramSocialSettings,
} from "@/lib/domain/types";

const normalizeAssetAddress = (chainId: ChainId | undefined, address: string) => (
  chainId === "solana" ? address.trim() : address.toLowerCase()
);

function mergeRiskSettings(stored: RiskSettings): RiskSettings {
  return {
    ...DEFAULT_RISK_SETTINGS,
    ...stored,
    networkFeeLimits: Object.fromEntries(
      Object.entries(DEFAULT_RISK_SETTINGS.networkFeeLimits!).map(([chainId, defaults]) => [
        chainId,
        { ...defaults, ...stored.networkFeeLimits?.[chainId as ChainId] },
      ]),
    ) as NonNullable<RiskSettings["networkFeeLimits"]>,
    networkExecutionLimits: Object.fromEntries(
      Object.entries(DEFAULT_RISK_SETTINGS.networkExecutionLimits!).map(([chainId, defaults]) => [
        chainId,
        { ...defaults, ...stored.networkExecutionLimits?.[chainId as ChainId] },
      ]),
    ) as NonNullable<RiskSettings["networkExecutionLimits"]>,
    assetPolicy: {
      ...DEFAULT_RISK_SETTINGS.assetPolicy!,
      ...stored.assetPolicy,
      trustedAssets: Object.fromEntries(
        Object.entries(DEFAULT_RISK_SETTINGS.assetPolicy!.trustedAssets).map(([chainId, defaults]) => [
          chainId,
          stored.assetPolicy?.trustedAssets?.[chainId as ChainId] ?? defaults,
        ]),
      ) as NonNullable<RiskSettings["assetPolicy"]>["trustedAssets"],
      deniedAssets: Object.fromEntries(
        Object.entries(DEFAULT_RISK_SETTINGS.assetPolicy!.deniedAssets).map(([chainId, defaults]) => [
          chainId,
          stored.assetPolicy?.deniedAssets?.[chainId as ChainId] ?? defaults,
        ]),
      ) as NonNullable<RiskSettings["assetPolicy"]>["deniedAssets"],
    },
  };
}

export const store = {
  reserveAiRequest(
    purpose: "copy_trade" | "social_signal",
    dailyLimit = 100,
    purposeDailyLimit = dailyLimit,
  ) {
    const now = new Date();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const database = getDatabase();
    const used = Number((database.prepare(
      "SELECT COUNT(*) AS count FROM ai_request_usage WHERE created_at >= ?",
    ).get(dayStart.toISOString()) as { count: number }).count);
    if (used >= dailyLimit) return false;
    const purposeUsed = Number((database.prepare(
      "SELECT COUNT(*) AS count FROM ai_request_usage WHERE created_at >= ? AND purpose = ?",
    ).get(dayStart.toISOString(), purpose) as { count: number }).count);
    if (purposeUsed >= purposeDailyLimit) return false;
    database.prepare("INSERT INTO ai_request_usage (id, purpose, created_at) VALUES (?, ?, ?)")
      .run(crypto.randomUUID(), purpose, now.toISOString());
    return true;
  },

  getAiRequestUsageToday(purpose?: "copy_trade" | "social_signal") {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const row = purpose
      ? getDatabase().prepare(
        "SELECT COUNT(*) AS count FROM ai_request_usage WHERE created_at >= ? AND purpose = ?",
      ).get(dayStart.toISOString(), purpose)
      : getDatabase().prepare(
        "SELECT COUNT(*) AS count FROM ai_request_usage WHERE created_at >= ?",
      ).get(dayStart.toISOString());
    return Number((row as { count: number }).count);
  },

  getTelegramSocialSettings(): TelegramSocialSettings {
    let stored: Partial<TelegramSocialSettings> | undefined;
    try {
      stored = getSetting<Partial<TelegramSocialSettings>>("telegramSocialSettings");
    } catch {
      stored = undefined;
    }
    return {
      enabled: stored?.enabled ?? false,
      selectedChatIds: [...new Set(stored?.selectedChatIds ?? [])],
      dailyAiLimit: Math.min(100, Math.max(1, stored?.dailyAiLimit ?? 40)),
    };
  },

  setTelegramSocialSettings(value: TelegramSocialSettings) {
    setSetting("telegramSocialSettings", {
      enabled: Boolean(value.enabled),
      selectedChatIds: [...new Set(value.selectedChatIds)],
      dailyAiLimit: Math.min(100, Math.max(1, Math.trunc(value.dailyAiLimit))),
    });
  },

  upsertSocialTokenSignal(signal: SocialTokenSignal) {
    getDatabase().prepare(`
      INSERT INTO social_token_signals
      (id, chat_id, chat_title, message_id, chain_id, dexscreener_chain_id, token_address, token_symbol, ticker,
       reference_type, status, price_usd, liquidity_usd, volume_24h_usd,
       price_change_24h_percent, market_cap_usd, pair_address, error_message, resolver_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        chain_id = excluded.chain_id,
        dexscreener_chain_id = excluded.dexscreener_chain_id,
        token_address = excluded.token_address,
        token_symbol = excluded.token_symbol,
        status = excluded.status,
        price_usd = excluded.price_usd,
        liquidity_usd = excluded.liquidity_usd,
        volume_24h_usd = excluded.volume_24h_usd,
        price_change_24h_percent = excluded.price_change_24h_percent,
        market_cap_usd = excluded.market_cap_usd,
        pair_address = excluded.pair_address,
        error_message = excluded.error_message,
        resolver_version = excluded.resolver_version,
        updated_at = excluded.updated_at
    `).run(
      signal.id, signal.chatId, signal.chatTitle, signal.messageId, signal.chainId, signal.dexScreenerChainId,
      signal.tokenAddress, signal.tokenSymbol, signal.ticker, signal.referenceType,
      signal.status, signal.priceUsd, signal.liquidityUsd, signal.volume24hUsd,
      signal.priceChange24hPercent, signal.marketCapUsd, signal.pairAddress,
      signal.errorMessage, signal.resolverVersion, signal.createdAt, signal.updatedAt,
    );
  },

  listSocialTokenSignals(limit = 200): SocialTokenSignal[] {
    return (getDatabase().prepare(
      "SELECT * FROM social_token_signals ORDER BY created_at DESC LIMIT ?",
    ).all(limit) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      chatId: String(row.chat_id),
      chatTitle: String(row.chat_title),
      messageId: String(row.message_id),
      chainId: row.chain_id ? row.chain_id as ChainId : null,
      dexScreenerChainId: row.dexscreener_chain_id ? String(row.dexscreener_chain_id) : null,
      tokenAddress: row.token_address ? String(row.token_address) : null,
      tokenSymbol: row.token_symbol ? String(row.token_symbol) : null,
      ticker: row.ticker ? String(row.ticker) : null,
      referenceType: row.reference_type as SocialTokenSignal["referenceType"],
      status: row.status as SocialTokenSignal["status"],
      priceUsd: Number(row.price_usd),
      liquidityUsd: Number(row.liquidity_usd),
      volume24hUsd: Number(row.volume_24h_usd),
      priceChange24hPercent: Number(row.price_change_24h_percent),
      marketCapUsd: row.market_cap_usd === null ? null : Number(row.market_cap_usd),
      pairAddress: row.pair_address ? String(row.pair_address) : null,
      errorMessage: row.error_message ? String(row.error_message) : null,
      resolverVersion: row.resolver_version ? String(row.resolver_version) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  },

  hasAiTradeAdvisory(id: string) {
    return Boolean(getDatabase().prepare("SELECT 1 FROM ai_trade_advisories WHERE id = ?").get(id));
  },

  insertAiTradeAdvisory(advisory: AiTradeAdvisory) {
    getDatabase().prepare(`
      INSERT OR IGNORE INTO ai_trade_advisories
      (id, chain_id, mode, side, asset, wallet_id, wallet_label, source_reference,
       recommendation, confidence, risk_level, summary, risk_flags, summary_tr, summary_en,
       risk_flags_tr, risk_flags_en, project_purpose_tr, project_purpose_en, social_assessment_tr,
       social_assessment_en, research_sources, provider, model,
       latency_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      advisory.id, advisory.chainId, advisory.mode, advisory.side, advisory.asset,
      advisory.walletId, advisory.walletLabel, advisory.sourceReference,
      advisory.recommendation, advisory.confidence, advisory.riskLevel,
      advisory.summaryTr, JSON.stringify(advisory.riskFlagsTr),
      advisory.summaryTr, advisory.summaryEn, JSON.stringify(advisory.riskFlagsTr),
      JSON.stringify(advisory.riskFlagsEn), advisory.projectPurposeTr, advisory.projectPurposeEn,
      advisory.socialAssessmentTr, advisory.socialAssessmentEn, JSON.stringify(advisory.researchSources),
      advisory.provider, advisory.model,
      advisory.latencyMs, advisory.createdAt,
    );
  },

  listAiTradeAdvisories(limit = 100): AiTradeAdvisory[] {
    return (getDatabase().prepare(`
      SELECT * FROM ai_trade_advisories ORDER BY created_at DESC LIMIT ?
    `).all(limit) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      chainId: row.chain_id as ChainId,
      mode: row.mode as TradingMode,
      side: row.side as AiTradeAdvisory["side"],
      asset: String(row.asset),
      walletId: row.wallet_id ? String(row.wallet_id) : null,
      walletLabel: row.wallet_label ? String(row.wallet_label) : null,
      sourceReference: String(row.source_reference),
      recommendation: row.recommendation as AiTradeAdvisory["recommendation"],
      confidence: Number(row.confidence),
      riskLevel: row.risk_level as AiTradeAdvisory["riskLevel"],
      summaryTr: String(row.summary_tr),
      summaryEn: String(row.summary_en),
      projectPurposeTr: String(row.project_purpose_tr ?? ""),
      projectPurposeEn: String(row.project_purpose_en ?? ""),
      socialAssessmentTr: String(row.social_assessment_tr ?? ""),
      socialAssessmentEn: String(row.social_assessment_en ?? ""),
      researchSources: safeJson<string[]>(row.research_sources as string, []),
      riskFlagsTr: safeJson<string[]>(row.risk_flags_tr as string, []),
      riskFlagsEn: safeJson<string[]>(row.risk_flags_en as string, []),
      provider: "groq",
      model: String(row.model),
      latencyMs: Number(row.latency_ms),
      createdAt: String(row.created_at),
    }));
  },

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
    const hypercoreTrades = (database.prepare("SELECT * FROM hypercore_trades WHERE wallet_id IS NOT NULL").all() as Record<string, unknown>[]).map(mapHypercoreTrade);
    const hypercorePositions = (database.prepare("SELECT * FROM hypercore_positions WHERE wallet_id IS NOT NULL").all() as Record<string, unknown>[]).map(mapHypercorePosition);
    const hypercorePnlByWallet = calculateHypercoreWalletCopyPnl(hypercoreTrades, hypercorePositions);
    const mode = this.getMode();
    const executionLots = mode === "paper" ? [] : this.listExecutionLots(mode).filter((lot) => lot.source === "copy" && lot.walletId);
    const executionAttempts = mode === "paper" ? [] : this.listExecutionAttempts(10_000).filter((attempt) => attempt.mode === mode && attempt.source === "copy" && attempt.walletId);
    return (database.prepare(`
      SELECT wallets.*, COALESCE(copy_counts.copied_trade_count, 0) AS copied_trade_count
      FROM wallets
      LEFT JOIN (
        SELECT wallet_id, COUNT(*) AS copied_trade_count
        FROM trades
        WHERE source = 'copy' AND status = 'confirmed' AND wallet_id IS NOT NULL
        GROUP BY wallet_id
      ) AS copy_counts ON copy_counts.wallet_id = wallets.id
      ORDER BY wallets.is_favorite DESC, wallets.score DESC, wallets.created_at DESC
    `).all() as Record<string, unknown>[])
      .map(mapWallet)
      .map((wallet) => {
        const copiedTrades = (database.prepare(`
          SELECT * FROM trades WHERE wallet_id = ? AND source = 'copy' ORDER BY created_at ASC
        `).all(wallet.id) as Record<string, unknown>[]).map(mapTrade);
        const confirmed = copiedTrades.filter((trade) => trade.status === "confirmed");
        const walletHypercoreTrades = hypercoreTrades.filter((trade) => trade.walletId === wallet.id);
        const confirmedHypercore = walletHypercoreTrades.filter((trade) => trade.status === "confirmed");
        const copiedHypercore = confirmedHypercore.filter((trade) => trade.source === "copy");
        const evmOutcomes = confirmed.filter((trade) => trade.side === "sell").map((trade) => trade.realizedPnlUsd);
        const hypercoreOutcomes = confirmedHypercore.filter((trade) => ["reduce", "close", "spot_sell"].includes(trade.action)).map((trade) => trade.realizedPnlUsd);
        const executionWalletLots = executionLots.filter((lot) => lot.walletId === wallet.id);
        const walletExecutionAttempts = executionAttempts.filter((attempt) => attempt.walletId === wallet.id);
        const outcomes = mode === "paper"
          ? [...evmOutcomes, ...hypercoreOutcomes]
          : executionWalletLots.filter((lot) => Math.abs(lot.realizedPnlUsd) > 0.000001).map((lot) => lot.realizedPnlUsd);
        const wins = outcomes.filter((pnl) => pnl > 0).length;
        const walletHypercorePositions = hypercorePositions.filter((position) => position.walletId === wallet.id);
        const copyPnlUsd = mode === "paper"
          ? (pnlByWallet.get(wallet.id) ?? 0) + (hypercorePnlByWallet.get(wallet.id) ?? 0)
          : executionWalletLots.reduce((sum, lot) => sum + executionLotNetPnl(lot), 0);
        const investedUsd = mode === "paper"
          ? pnlLots.filter((lot) => lot.wallet_id === wallet.id).reduce((sum, lot) => sum + Number(lot.buy_cost_usd), 0) + walletHypercorePositions.reduce((sum, position) => sum + position.marginUsd, 0)
          : executionWalletLots.reduce((sum, lot) => sum + lot.entryCostUsd, 0);
        const executionSuccessCount = walletExecutionAttempts.filter((attempt) => attempt.status === "simulated" || attempt.status === "confirmed").length;
        const confirmedCount = mode === "paper" ? confirmed.length + copiedHypercore.length : executionSuccessCount;
        const dynamic = calculateWalletScore({
          totalTrades: confirmedCount,
          winRate: outcomes.length ? wins / outcomes.length : 0.5,
          realizedPnlPercent: investedUsd ? copyPnlUsd / investedUsd * 100 : 0,
          maxDrawdownPercent: wallet.maxDrawdownPercent,
          copyableTradeRatio: mode === "paper"
            ? (copiedTrades.length ? confirmed.length / copiedTrades.length : 0.5)
            : (walletExecutionAttempts.length ? executionSuccessCount / walletExecutionAttempts.length : 0.5),
          suspiciousActivityRatio: Math.max(0, (100 - wallet.scoreBreakdown.safety) / 100),
        });
        const evidenceWeight = Math.min(1, confirmedCount / 10);
        const blend = (observed: number, calculated: number) => Math.round(observed * (1 - evidenceWeight) + calculated * evidenceWeight);
        const scoreBreakdown = {
          profitability: blend(wallet.scoreBreakdown.profitability, dynamic.breakdown.profitability),
          consistency: blend(wallet.scoreBreakdown.consistency, dynamic.breakdown.consistency),
          riskControl: blend(wallet.scoreBreakdown.riskControl, dynamic.breakdown.riskControl),
          copyability: blend(wallet.scoreBreakdown.copyability, dynamic.breakdown.copyability),
          safety: blend(wallet.scoreBreakdown.safety, dynamic.breakdown.safety),
        };
        const score = Math.round(scoreBreakdown.profitability * .25 + scoreBreakdown.consistency * .2 + scoreBreakdown.riskControl * .2 + scoreBreakdown.copyability * .2 + scoreBreakdown.safety * .15);
        const copyPnlPercent = investedUsd > 0 ? copyPnlUsd / investedUsd * 100 : 0;
        return {
          ...wallet,
          score,
          scoreBreakdown,
          copiedTradeCount: mode === "paper" ? wallet.copiedTradeCount + copiedHypercore.length : executionSuccessCount,
          winRate: outcomes.length ? wins / outcomes.length * 100 : wallet.winRate,
          realizedPnlUsd: copyPnlUsd,
          copyPnlPercent,
          copyInvestedUsd: investedUsd,
        };
      })
      .sort((left, right) => {
        const pausedOrder = Number(left.state === "paused") - Number(right.state === "paused");
        const favoriteOrder = Number(right.isFavorite) - Number(left.isFavorite);
        return pausedOrder || favoriteOrder || right.score - left.score || right.updatedAt.localeCompare(left.updatedAt);
      });
  },

  listActiveWalletAddresses(chainId: ChainId): string[] {
    const rows = getDatabase().prepare("SELECT address, is_favorite, tracked_chain_ids FROM wallets WHERE state != 'paused'").all() as Array<{ address: string; is_favorite: number; tracked_chain_ids: string }>;
    return rows
      .filter((row) => {
        try {
          return walletTracksEffectiveChain({
            address: row.address,
            isFavorite: Boolean(row.is_favorite),
            trackedChainIds: parseTrackedChainIds(row.tracked_chain_ids),
          }, chainId);
        } catch {
          return false;
        }
      })
      .map((row) => chainId === "solana" ? row.address : row.address.toLowerCase())
      .filter((address) => chainId !== "solana" || isValidSolanaPublicKey(address));
  },

  repairInvalidSolanaWallets() {
    const rows = getDatabase().prepare(`
      SELECT id, address, tracked_chain_ids FROM wallets
      WHERE state != 'paused' AND tracked_chain_ids LIKE '%solana%'
    `).all() as Array<{ id: string; address: string; tracked_chain_ids: string }>;
    const invalidRows = rows.filter((row) =>
      parseTrackedChainIds(row.tracked_chain_ids).includes("solana") && !isValidSolanaPublicKey(row.address)
    );
    if (!invalidRows.length) return 0;
    const update = getDatabase().prepare("UPDATE wallets SET state = 'paused', pause_reason = ?, updated_at = ? WHERE id = ?");
    const updatedAt = new Date().toISOString();
    for (const row of invalidRows) {
      update.run("Eski sürümde adres harf yapısı bozulduğu için Solana takibi güvenli biçimde duraklatıldı. Cüzdanı doğru adresle yeniden ekleyin.", updatedAt, row.id);
    }
    return invalidRows.length;
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

  findWalletByAddress(address: string, chainId?: ChainId): TrackedWallet | null {
    return this.listWallets().find((wallet) =>
      (chainId === "solana" ? wallet.address === address : wallet.address === address.toLowerCase())
      && (!chainId || walletTracksEffectiveChain(wallet, chainId))
    ) ?? null;
  },

  getWallet(walletId: string): TrackedWallet | null {
    const row = getDatabase().prepare("SELECT * FROM wallets WHERE id = ?").get(walletId) as Record<string, unknown> | undefined;
    return row ? mapWallet(row) : null;
  },

  insertWallet(wallet: TrackedWallet) {
    getDatabase().prepare(`
      INSERT INTO wallets
      (id, address, label, is_favorite, tracked_chain_ids, state, score, score_breakdown, total_trades, observation_swap_count, win_rate, realized_pnl_usd, max_drawdown_percent, average_hold_minutes, pause_reason, addition_context, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      wallet.id,
      wallet.trackedChainIds.includes("solana") ? wallet.address : wallet.address.toLowerCase(),
      wallet.label,
      wallet.isFavorite ? 1 : 0,
      JSON.stringify(wallet.trackedChainIds),
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

  addWalletTrackedChain(walletId: string, chainId: ChainId, activate = false): TrackedWallet {
    const wallet = this.getWallet(walletId);
    if (!wallet) throw new Error("Cüzdan bulunamadı.");
    const trackedChainIds = [...new Set([...wallet.trackedChainIds, chainId])];
    const state = activate && wallet.state !== "paused" ? "active" : wallet.state;
    const updatedAt = new Date().toISOString();
    getDatabase().prepare("UPDATE wallets SET tracked_chain_ids = ?, state = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(trackedChainIds), state, updatedAt, walletId);
    return { ...wallet, trackedChainIds, state, updatedAt };
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
      : wallet.state === "active" || totalTrades >= 10 ? "active" : "observing";
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
      WHERE wallet_id = ? AND chain_id = ? AND observed_at >= ?
    `).get(hourStart, walletId, chainId, dayStart) as { hour_count: number | null; day_count: number };
    const settings = this.getRiskSettings();
    const limits = walletActivityLimitsFor(chainId, settings);
    const swapsLastHour = Number(counts.hour_count ?? 0);
    const swapsLast24Hours = Number(counts.day_count ?? 0);
    const decision = evaluateWalletActivityLimit({
      swapsLastHour,
      swapsLast24Hours,
      ...limits,
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
      SELECT chain_id,
        SUM(CASE WHEN observed_at >= ? THEN 1 ELSE 0 END) AS hour_count,
        COUNT(*) AS day_count
      FROM wallet_swap_activity
      WHERE wallet_id = ? AND observed_at >= ?
      GROUP BY chain_id
    `);
    const paused: Array<{ id: string; label: string; chainId: ChainId; reason: string; swapsLastHour: number; swapsLast24Hours: number }> = [];
    for (const wallet of wallets) {
      const networkCounts = countQuery.all(hourStart, wallet.id, dayStart) as Array<{ chain_id: ChainId; hour_count: number | null; day_count: number }>;
      for (const counts of networkCounts) {
        const swapsLastHour = Number(counts.hour_count ?? 0);
        const swapsLast24Hours = Number(counts.day_count ?? 0);
        const limits = walletActivityLimitsFor(counts.chain_id, settings);
        const decision = evaluateWalletActivityLimit({
          swapsLastHour,
          swapsLast24Hours,
          ...limits,
        });
        if (!decision.exceeded || !decision.reason) continue;
        const reason = `${counts.chain_id}: ${decision.reason}`;
        database.prepare("UPDATE wallets SET state = 'paused', pause_reason = ?, updated_at = ? WHERE id = ?")
          .run(reason, observedAt, wallet.id);
        paused.push({ id: wallet.id, label: wallet.label, chainId: counts.chain_id, reason, swapsLastHour, swapsLast24Hours });
        break;
      }
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

  registerExecutionBuySignal(mode: Exclude<TradingMode, "paper">, integrationId: ChainId, assetKey: string, walletId: string, reference?: string) {
    const database = getDatabase();
    const normalizedAsset = assetKey.toLowerCase();
    const now = new Date().toISOString();
    const inserted = database.prepare(`
      INSERT OR IGNORE INTO execution_copy_signals
      (mode, integration_id, asset_key, wallet_id, first_reference, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(mode, integrationId, normalizedAsset, walletId, reference ?? null, now);
    database.prepare(`
      INSERT OR IGNORE INTO execution_copy_consensus
      (mode, integration_id, asset_key, copied_stages, pending_stage, updated_at)
      VALUES (?, ?, ?, 0, NULL, ?)
    `).run(mode, integrationId, normalizedAsset, now);
    const signalRow = database.prepare(`
      SELECT COUNT(*) AS count FROM execution_copy_signals
      WHERE mode = ? AND integration_id = ? AND asset_key = ?
    `).get(mode, integrationId, normalizedAsset) as { count: number };
    const state = database.prepare(`
      SELECT copied_stages, pending_stage FROM execution_copy_consensus
      WHERE mode = ? AND integration_id = ? AND asset_key = ?
    `).get(mode, integrationId, normalizedAsset) as { copied_stages: number; pending_stage: number | null };
    const decision = canTriggerNextBuy({
      completedBuyStages: state.copied_stages,
      distinctWalletCount: Number(signalRow.count),
      isNewWallet: inserted.changes > 0,
      hasPendingStage: state.pending_stage !== null,
    });
    const stage = state.copied_stages + 1;
    if (decision.shouldCopy) {
      database.prepare(`
        UPDATE execution_copy_consensus SET pending_stage = ?, updated_at = ?
        WHERE mode = ? AND integration_id = ? AND asset_key = ? AND pending_stage IS NULL
      `).run(stage, now, mode, integrationId, normalizedAsset);
    }
    return { ...decision, distinctWalletCount: Number(signalRow.count), stage };
  },

  finishExecutionBuyStage(
    mode: Exclude<TradingMode, "paper">,
    integrationId: ChainId,
    assetKey: string,
    stage: number,
    confirmed: boolean,
    retryWalletId?: string,
  ) {
    const normalizedAsset = assetKey.toLowerCase();
    const now = new Date().toISOString();
    if (confirmed) {
      getDatabase().prepare(`
        UPDATE execution_copy_consensus SET copied_stages = ?, pending_stage = NULL, updated_at = ?
        WHERE mode = ? AND integration_id = ? AND asset_key = ? AND pending_stage = ?
      `).run(stage, now, mode, integrationId, normalizedAsset, stage);
      return;
    }
    const database = getDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const released = database.prepare(`
        UPDATE execution_copy_consensus SET pending_stage = NULL, updated_at = ?
        WHERE mode = ? AND integration_id = ? AND asset_key = ? AND pending_stage = ?
      `).run(now, mode, integrationId, normalizedAsset, stage);
      if (released.changes > 0 && retryWalletId) {
        database.prepare(`
          DELETE FROM execution_copy_signals
          WHERE mode = ? AND integration_id = ? AND asset_key = ? AND wallet_id = ?
        `).run(mode, integrationId, normalizedAsset, retryWalletId);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  },

  setWalletPaused(walletId: string, paused: boolean) {
    const wallet = this.getWallet(walletId);
    if (!wallet) throw new Error("Cüzdan bulunamadı.");
    const state = paused ? "paused" : "active";
    const updatedAt = new Date().toISOString();
    const pauseReason = paused ? "Kullanıcı tarafından manuel olarak duraklatıldı." : null;
    const database = getDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("UPDATE wallets SET state = ?, pause_reason = ?, updated_at = ? WHERE id = ?").run(state, pauseReason, updatedAt, walletId);
      if (!paused) {
        // Kullanıcı yeniden başlattığında eski yoğunluk penceresi cüzdanı anında tekrar kapatmamalı.
        database.prepare("DELETE FROM wallet_swap_activity WHERE wallet_id = ?").run(walletId);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return { ...wallet, state, pauseReason, updatedAt };
  },

  setWalletFavorite(walletId: string, isFavorite: boolean) {
    const wallet = this.getWallet(walletId);
    if (!wallet) throw new Error("Cüzdan bulunamadı.");
    const updatedAt = new Date().toISOString();
    const state = isFavorite ? "active" : wallet.state;
    const pauseReason = isFavorite ? null : wallet.pauseReason;
    const database = getDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare(`
        UPDATE wallets
        SET is_favorite = ?, state = ?, pause_reason = ?, updated_at = ?
        WHERE id = ?
      `).run(isFavorite ? 1 : 0, state, pauseReason, updatedAt, walletId);
      if (isFavorite) database.prepare("DELETE FROM wallet_swap_activity WHERE wallet_id = ?").run(walletId);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return { ...wallet, isFavorite, state, pauseReason, updatedAt };
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

  listHypercorePositions(): HypercorePaperPosition[] {
    return (getDatabase().prepare("SELECT * FROM hypercore_positions ORDER BY updated_at DESC").all() as Record<string, unknown>[])
      .map(mapHypercorePosition);
  },

  getHypercorePositionById(positionId: string) {
    const row = getDatabase().prepare("SELECT * FROM hypercore_positions WHERE id = ?").get(positionId);
    return row ? mapHypercorePosition(row as Record<string, unknown>) : null;
  },

  getHypercorePosition(walletId: string | null, coin: string, marketType: HypercorePaperPosition["marketType"], side: HypercorePaperPosition["side"]) {
    const row = walletId
      ? getDatabase().prepare("SELECT * FROM hypercore_positions WHERE wallet_id = ? AND coin = ? AND market_type = ? AND side = ?").get(walletId, coin, marketType, side)
      : getDatabase().prepare("SELECT * FROM hypercore_positions WHERE wallet_id IS NULL AND coin = ? AND market_type = ? AND side = ?").get(coin, marketType, side);
    return row ? mapHypercorePosition(row as Record<string, unknown>) : null;
  },

  upsertHypercorePosition(position: HypercorePaperPosition) {
    getDatabase().prepare(`
      INSERT INTO hypercore_positions
      (id, wallet_id, wallet_label, coin, market_type, side, quantity, entry_price_usd, current_price_usd, margin_usd, leverage, liquidation_price_usd, unrealized_pnl_usd, funding_usd, opened_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        wallet_label = excluded.wallet_label,
        quantity = excluded.quantity,
        entry_price_usd = excluded.entry_price_usd,
        current_price_usd = excluded.current_price_usd,
        margin_usd = excluded.margin_usd,
        leverage = excluded.leverage,
        liquidation_price_usd = excluded.liquidation_price_usd,
        unrealized_pnl_usd = excluded.unrealized_pnl_usd,
        funding_usd = excluded.funding_usd,
        updated_at = excluded.updated_at
    `).run(
      position.id, position.walletId, position.walletLabel, position.coin, position.marketType, position.side,
      position.quantity, position.entryPriceUsd, position.currentPriceUsd, position.marginUsd, position.leverage,
      position.liquidationPriceUsd, position.unrealizedPnlUsd, position.fundingUsd, position.openedAt, position.updatedAt,
    );
    return position;
  },

  deleteHypercorePosition(id: string) {
    getDatabase().prepare("DELETE FROM hypercore_positions WHERE id = ?").run(id);
  },

  listHypercoreTrades(limit = 100): HypercorePaperTrade[] {
    return (getDatabase().prepare("SELECT * FROM hypercore_trades ORDER BY created_at DESC LIMIT ?").all(limit) as Record<string, unknown>[])
      .map(mapHypercoreTrade);
  },

  getHypercoreFeesUsd(): number {
    const row = getDatabase().prepare("SELECT COALESCE(SUM(fee_usd + funding_usd), 0) AS total FROM hypercore_trades WHERE status = 'confirmed'").get() as { total: number };
    return Number(row.total);
  },

  hasHypercoreFill(fillId: string) {
    return Boolean(getDatabase().prepare("SELECT 1 FROM hypercore_trades WHERE source_fill_id = ? LIMIT 1").get(fillId));
  },

  insertHypercoreTrade(trade: HypercorePaperTrade) {
    getDatabase().prepare(`
      INSERT INTO hypercore_trades
      (id, wallet_id, source, coin, market_type, side, position_side, action, quantity, price_usd, notional_usd, margin_usd, leverage, fee_usd, funding_usd, realized_pnl_usd, status, reason, source_fill_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trade.id, trade.walletId, trade.source, trade.coin, trade.marketType, trade.side, trade.positionSide,
      trade.action, trade.quantity, trade.priceUsd, trade.notionalUsd, trade.marginUsd, trade.leverage,
      trade.feeUsd, trade.fundingUsd, trade.realizedPnlUsd, trade.status, trade.reason, trade.sourceFillId, trade.createdAt,
    );
    return trade;
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
      normalizeAssetAddress(trade.chainId, trade.tokenAddress),
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

  getExecutionAttempt(requestId: string): ExecutionAttempt | null {
    const row = getDatabase().prepare("SELECT * FROM execution_attempts WHERE request_id = ?").get(requestId) as Record<string, unknown> | undefined;
    return row ? mapExecutionAttempt(row) : null;
  },

  getExecutionAttemptByIdempotencyKey(idempotencyKey: string): ExecutionAttempt | null {
    const row = getDatabase().prepare("SELECT * FROM execution_attempts WHERE idempotency_key = ?").get(idempotencyKey) as Record<string, unknown> | undefined;
    return row ? mapExecutionAttempt(row) : null;
  },

  listExecutionAttempts(limit = 500): ExecutionAttempt[] {
    return (getDatabase().prepare("SELECT * FROM execution_attempts ORDER BY created_at DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map(mapExecutionAttempt);
  },

  insertExecutionAttempt(input: { requestId: string; idempotencyKey?: string; integrationId: ChainId; walletId?: string | null; mode: Exclude<TradingMode, "paper">; source: "manual" | "copy" | "certification"; action: string; asset: string; availableBalanceUsd?: number }) {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const idempotencyKey = input.idempotencyKey ?? input.requestId;
    getDatabase().prepare(`
      INSERT INTO execution_attempts
      (id, request_id, idempotency_key, integration_id, wallet_id, mode, source, action, asset, status, amount_in, amount_out,
       available_balance_usd, tx_hash, error_message, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', NULL, NULL, ?, NULL, NULL, ?, ?)
    `).run(id, input.requestId, idempotencyKey, input.integrationId, input.walletId ?? null, input.mode, input.source, input.action, input.asset, input.availableBalanceUsd ?? 0, now, now);
    return this.getExecutionAttempt(input.requestId)!;
  },

  claimExecutionAttempt(input: { requestId: string; idempotencyKey: string; integrationId: ChainId; walletId?: string | null; mode: Exclude<TradingMode, "paper">; source: "manual" | "copy" | "certification"; action: string; asset: string; availableBalanceUsd?: number }) {
    const existing = this.getExecutionAttemptByIdempotencyKey(input.idempotencyKey) ?? this.getExecutionAttempt(input.requestId);
    if (existing) return { attempt: existing, created: false };
    try {
      return { attempt: this.insertExecutionAttempt(input), created: true };
    } catch (error) {
      const raced = this.getExecutionAttemptByIdempotencyKey(input.idempotencyKey) ?? this.getExecutionAttempt(input.requestId);
      if (raced) return { attempt: raced, created: false };
      throw error;
    }
  },

  updateExecutionAttempt(requestId: string, update: {
    status: ExecutionAttempt["status"];
    amountIn?: bigint | string;
    amountOut?: bigint | string;
    expectedAmountOut?: string;
    minimumAmountOut?: string;
    quotedPriceUsd?: number;
    slippagePercent?: number;
    priceImpactPercent?: number;
    networkFeeUsd?: number;
    dexFeeUsd?: number;
    availableBalanceUsd?: number;
    simulationLatencyMs?: number;
    metadata?: Record<string, unknown>;
    txHash?: string | null;
    externalOrderId?: string | null;
    accountingStatus?: ExecutionAttempt["accountingStatus"];
    reconciliationStatus?: ExecutionAttempt["reconciliationStatus"];
    reconciliationDetails?: string | null;
    submittedAt?: string | null;
    confirmedAt?: string | null;
    accountedAt?: string | null;
    reconciledAt?: string | null;
    errorMessage?: string | null;
  }) {
    getDatabase().prepare(`
      UPDATE execution_attempts
      SET status = ?, amount_in = COALESCE(?, amount_in), amount_out = COALESCE(?, amount_out),
          expected_amount_out = COALESCE(?, expected_amount_out), minimum_amount_out = COALESCE(?, minimum_amount_out),
          quoted_price_usd = COALESCE(?, quoted_price_usd), slippage_percent = COALESCE(?, slippage_percent),
          price_impact_percent = COALESCE(?, price_impact_percent), network_fee_usd = COALESCE(?, network_fee_usd),
          dex_fee_usd = COALESCE(?, dex_fee_usd), available_balance_usd = COALESCE(?, available_balance_usd),
          simulation_latency_ms = COALESCE(?, simulation_latency_ms), metadata = COALESCE(?, metadata),
          tx_hash = COALESCE(?, tx_hash), external_order_id = COALESCE(?, external_order_id),
          accounting_status = COALESCE(?, accounting_status), reconciliation_status = COALESCE(?, reconciliation_status),
          reconciliation_details = COALESCE(?, reconciliation_details), submitted_at = COALESCE(?, submitted_at),
          confirmed_at = COALESCE(?, confirmed_at), accounted_at = COALESCE(?, accounted_at),
          reconciled_at = COALESCE(?, reconciled_at), error_message = ?, updated_at = ?
      WHERE request_id = ?
    `).run(
      update.status,
      update.amountIn?.toString() ?? null,
      update.amountOut?.toString() ?? null,
      update.expectedAmountOut ?? null,
      update.minimumAmountOut ?? null,
      update.quotedPriceUsd ?? null,
      update.slippagePercent ?? null,
      update.priceImpactPercent ?? null,
      update.networkFeeUsd ?? null,
      update.dexFeeUsd ?? null,
      update.availableBalanceUsd ?? null,
      update.simulationLatencyMs ?? null,
      update.metadata ? JSON.stringify(update.metadata) : null,
      update.txHash ?? null,
      update.externalOrderId ?? null,
      update.accountingStatus ?? null,
      update.reconciliationStatus ?? null,
      update.reconciliationDetails ?? null,
      update.submittedAt ?? null,
      update.confirmedAt ?? (update.status === "confirmed" ? new Date().toISOString() : null),
      update.accountedAt ?? null,
      update.reconciledAt ?? null,
      update.errorMessage ?? null,
      new Date().toISOString(),
      requestId,
    );
  },

  markExecutionAccounted(requestId: string) {
    const now = new Date().toISOString();
    getDatabase().prepare("UPDATE execution_attempts SET accounting_status = 'applied', accounted_at = ?, updated_at = ? WHERE request_id = ?")
      .run(now, now, requestId);
  },

  listPendingLiveExecutionAttempts(limit = 100): ExecutionAttempt[] {
    return (getDatabase().prepare(`
      SELECT * FROM execution_attempts
      WHERE mode = 'live' AND (status IN ('submitting', 'submitted') OR (status = 'confirmed' AND reconciliation_status = 'pending'))
      ORDER BY created_at ASC LIMIT ?
    `).all(limit) as Record<string, unknown>[]).map(mapExecutionAttempt);
  },

  countUnresolvedLiveExecutionAttempts(integrationId: ChainId): number {
    const row = getDatabase().prepare(`
      SELECT COUNT(*) AS count
      FROM execution_attempts
      WHERE mode = 'live'
        AND integration_id = ?
        AND (
          status IN ('submitting', 'submitted', 'stale')
          OR reconciliation_status = 'failed'
        )
    `).get(integrationId) as { count: number };
    return row.count;
  },

  listExecutionLots(mode?: ExecutionLot["mode"], integrationId?: ChainId): ExecutionLot[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (mode) { clauses.push("mode = ?"); params.push(mode); }
    if (integrationId) { clauses.push("integration_id = ?"); params.push(integrationId); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return (getDatabase().prepare(`SELECT * FROM execution_lots ${where} ORDER BY opened_at ASC`).all(...params) as Record<string, unknown>[]).map(mapExecutionLot);
  },

  getOpenExecutionLots(input: { integrationId: ChainId; mode: ExecutionLot["mode"]; assetKey: string; walletId?: string | null; positionSide?: ExecutionLot["positionSide"] }) {
    const assetKey = normalizeExecutionAssetKey(input.integrationId, input.assetKey);
    return this.listExecutionLots(input.mode, input.integrationId).filter((lot) =>
      lot.status === "open" &&
      normalizeExecutionAssetKey(input.integrationId, lot.assetKey) === assetKey &&
      (input.walletId === undefined || lot.walletId === input.walletId) &&
      (input.positionSide === undefined || lot.positionSide === input.positionSide),
    );
  },

  insertExecutionLot(lot: Omit<ExecutionLot,
    "initialAmount" | "assetSymbol" | "pairAddress" | "assetDecimals" | "entryPriceUsd" | "currentPriceUsd" |
    "entryCostUsd" | "realizedPnlUsd" | "feesUsd" | "leverage"
  > & Partial<Pick<ExecutionLot,
    "initialAmount" | "assetSymbol" | "pairAddress" | "assetDecimals" | "entryPriceUsd" | "currentPriceUsd" |
    "entryCostUsd" | "realizedPnlUsd" | "feesUsd" | "leverage"
  >>) {
    const complete: ExecutionLot = {
      ...lot,
      initialAmount: lot.initialAmount ?? lot.amount,
      assetSymbol: lot.assetSymbol ?? "",
      pairAddress: lot.pairAddress ?? null,
      assetDecimals: lot.assetDecimals ?? 0,
      entryPriceUsd: lot.entryPriceUsd ?? 0,
      currentPriceUsd: lot.currentPriceUsd ?? lot.entryPriceUsd ?? 0,
      entryCostUsd: lot.entryCostUsd ?? 0,
      realizedPnlUsd: lot.realizedPnlUsd ?? 0,
      feesUsd: lot.feesUsd ?? 0,
      leverage: lot.leverage ?? 1,
    };
    getDatabase().prepare(`
      INSERT INTO execution_lots
      (id, integration_id, mode, asset_key, wallet_id, source, market_type, position_side,
       amount, initial_amount, amount_format, asset_symbol, pair_address, asset_decimals, entry_price_usd,
       current_price_usd, entry_cost_usd, realized_pnl_usd, fees_usd, leverage,
       entry_reference, status, opened_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      complete.id, complete.integrationId, complete.mode, normalizeExecutionAssetKey(complete.integrationId, complete.assetKey), complete.walletId, complete.source,
      complete.marketType, complete.positionSide, complete.amount, complete.initialAmount, complete.amountFormat,
      complete.assetSymbol, complete.pairAddress ?? null, complete.assetDecimals, complete.entryPriceUsd, complete.currentPriceUsd, complete.entryCostUsd,
      complete.realizedPnlUsd, complete.feesUsd, complete.leverage, complete.entryReference, complete.status, complete.openedAt, complete.updatedAt,
    );
    if (complete.mode === "live") this.setReconciliation({ integrationId: complete.integrationId, status: "pending", details: "Yeni live lot sonrası mutabakat yenilenmeli.", checkedAt: null });
    return complete;
  },

  reduceExecutionLots(lots: ExecutionLot[], requestedAmount: string, accounting?: { netProceedsUsd: number; feesUsd: number }, dustThreshold = 0) {
    if (!lots.length) throw new Error("Azaltılabilecek execution lotu bulunamadı.");
    const format = lots[0].amountFormat;
    if (format === "base_units") {
      let remaining = BigInt(requestedAmount);
      const requested = BigInt(requestedAmount);
      for (const lot of lots) {
        const current = BigInt(lot.amount);
        const consumed = current < remaining ? current : remaining;
        const next = current - consumed;
        const ratio = requested > 0n ? Number(consumed * 1_000_000n / requested) / 1_000_000 : 0;
        updateLot(lot, next.toString(), next === 0n ? "closed" : "open", accounting, ratio);
        remaining -= consumed;
        if (remaining === 0n) break;
      }
    } else {
      let remaining = Number(requestedAmount);
      const requested = Number(requestedAmount);
      for (const lot of lots) {
        const current = Number(lot.amount);
        const consumed = Math.min(current, remaining);
        const remainder = Math.max(0, current - consumed);
        const next = remainder > 0 && remainder < dustThreshold ? 0 : remainder;
        updateLot(lot, String(next), next <= 1e-12 ? "closed" : "open", accounting, requested > 0 ? consumed / requested : 0);
        remaining = Math.max(0, remaining - consumed);
        if (remaining <= 1e-12) break;
      }
    }
    if (lots[0].mode === "live") this.setReconciliation({ integrationId: lots[0].integrationId, status: "pending", details: "Live lot azaltıldı; mutabakat yenilenmeli.", checkedAt: null });
  },

  updateExecutionLotMarket(id: string, currentPriceUsd: number, pairAddress?: string | null) {
    getDatabase().prepare(`
      UPDATE execution_lots
      SET current_price_usd = ?, pair_address = COALESCE(?, pair_address), updated_at = ?
      WHERE id = ?
    `).run(Math.max(0, currentPriceUsd), pairAddress ?? null, new Date().toISOString(), id);
  },

  expirePreparingExecutionAttempts(maxAgeMinutes = 15) {
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();
    return getDatabase().prepare(`
      UPDATE execution_attempts
      SET status = 'stale', error_message = 'Uygulama yeniden başlatıldı veya hazırlama zaman aşımına uğradı.', updated_at = ?
      WHERE status = 'preparing' AND created_at < ?
    `).run(new Date().toISOString(), cutoff).changes;
  },

  getShadowAccount(integrationId: ChainId): ShadowAccount | null {
    const row = getDatabase().prepare("SELECT * FROM shadow_accounts WHERE integration_id = ?").get(integrationId) as Record<string, unknown> | undefined;
    return row ? mapShadowAccount(row) : null;
  },

  listShadowAccounts(): ShadowAccount[] {
    return (getDatabase().prepare("SELECT * FROM shadow_accounts ORDER BY integration_id").all() as Record<string, unknown>[]).map(mapShadowAccount);
  },

  ensureShadowAccount(
    integrationId: ChainId,
    equityUsd: number,
    fundingToken: { symbol: string; amount: number; priceUsd: number },
  ): ShadowAccount {
    const now = new Date().toISOString();
    const date = now.slice(0, 10);
    getDatabase().prepare(`
      INSERT OR IGNORE INTO shadow_accounts
      (integration_id, starting_equity_usd, cash_balance_usd, realized_pnl_usd, total_costs_usd,
       daily_start_equity_usd, daily_start_date, created_at, updated_at,
       funding_token_symbol, funding_token_amount, funding_token_price_usd)
      VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      integrationId,
      equityUsd,
      equityUsd,
      equityUsd,
      date,
      now,
      now,
      fundingToken.symbol,
      fundingToken.amount,
      fundingToken.priceUsd,
    );
    return this.getShadowAccount(integrationId)!;
  },

  updateShadowAccount(account: ShadowAccount) {
    getDatabase().prepare(`
      UPDATE shadow_accounts
      SET cash_balance_usd = ?, realized_pnl_usd = ?, total_costs_usd = ?,
          daily_start_equity_usd = ?, daily_start_date = ?, funding_token_symbol = ?,
          funding_token_amount = ?, funding_token_price_usd = ?, updated_at = ?
      WHERE integration_id = ?
    `).run(
      account.cashBalanceUsd,
      account.realizedPnlUsd,
      account.totalCostsUsd,
      account.dailyStartEquityUsd,
      account.dailyStartDate,
      account.fundingTokenSymbol,
      account.fundingTokenAmount,
      account.fundingTokenPriceUsd,
      new Date().toISOString(),
      account.integrationId,
    );
  },

  archivePaperPeriod(snapshot: {
    startedAt: string; endedAt: string; startingBalanceUsd: number; endingEquityUsd: number;
    realizedPnlUsd: number; unrealizedPnlUsd: number; totalCostsUsd: number;
    confirmedTradeCount: number; openPositionCount: number; payload: unknown;
  }) {
    const id = crypto.randomUUID();
    getDatabase().prepare(`
      INSERT INTO paper_periods
      (id, started_at, ended_at, starting_balance_usd, ending_equity_usd, realized_pnl_usd,
       unrealized_pnl_usd, total_costs_usd, confirmed_trade_count, open_position_count, snapshot, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, snapshot.startedAt, snapshot.endedAt, snapshot.startingBalanceUsd, snapshot.endingEquityUsd,
      snapshot.realizedPnlUsd, snapshot.unrealizedPnlUsd, snapshot.totalCostsUsd,
      snapshot.confirmedTradeCount, snapshot.openPositionCount, JSON.stringify(snapshot.payload), new Date().toISOString());
    return id;
  },

  listReconciliation(): ReconciliationRecord[] {
    return (getDatabase().prepare("SELECT * FROM live_reconciliation ORDER BY integration_id").all() as Record<string, unknown>[]).map((row) => ({
      integrationId: row.integration_id as ChainId,
      status: row.status as ReconciliationRecord["status"],
      details: row.details as string,
      checkedAt: row.checked_at as string | null,
    }));
  },

  setReconciliation(record: ReconciliationRecord) {
    getDatabase().prepare(`
      INSERT INTO live_reconciliation (integration_id, status, details, checked_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(integration_id) DO UPDATE SET status = excluded.status, details = excluded.details, checked_at = excluded.checked_at
    `).run(record.integrationId, record.status, record.details, record.checkedAt);
  },

  listCertificationSteps(): CertificationStep[] {
    return (getDatabase().prepare("SELECT * FROM live_certification_steps ORDER BY integration_id, step_id").all() as Record<string, unknown>[]).map((row) => ({
      integrationId: row.integration_id as ChainId,
      stepId: row.step_id as string,
      status: row.status as CertificationStep["status"],
      reference: row.reference as string | null,
      details: row.details as string,
      checkedAt: row.checked_at as string | null,
    }));
  },

  setCertificationStep(step: CertificationStep) {
    getDatabase().prepare(`
      INSERT INTO live_certification_steps (integration_id, step_id, status, reference, details, checked_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(integration_id, step_id) DO UPDATE SET status = excluded.status, reference = excluded.reference, details = excluded.details, checked_at = excluded.checked_at
    `).run(step.integrationId, step.stepId, step.status, step.reference, step.details, step.checkedAt);
  },

  getOrCreateLiveDailyBaseline(integrationId: ChainId, date: string, equityUsd: number) {
    const database = getDatabase();
    database.prepare("INSERT OR IGNORE INTO live_daily_baselines (integration_id, date, equity_usd, created_at) VALUES (?, ?, ?, ?)")
      .run(integrationId, date, equityUsd, new Date().toISOString());
    const row = database.prepare("SELECT equity_usd FROM live_daily_baselines WHERE integration_id = ? AND date = ?").get(integrationId, date) as { equity_usd: number };
    return Number(row.equity_usd);
  },

  getLiveDailyBaselineRecord(integrationId: ChainId, date: string) {
    const row = getDatabase().prepare(`
      SELECT equity_usd, created_at
      FROM live_daily_baselines
      WHERE integration_id = ? AND date = ?
    `).get(integrationId, date) as { equity_usd: number; created_at: string } | undefined;
    return row ? { equityUsd: Number(row.equity_usd), createdAt: row.created_at } : null;
  },

  getLiveInitialBaselineRecord(integrationId: ChainId) {
    const row = getDatabase().prepare(`
      SELECT equity_usd, created_at
      FROM live_daily_baselines
      WHERE integration_id = ?
      ORDER BY date ASC, created_at ASC
      LIMIT 1
    `).get(integrationId) as { equity_usd: number; created_at: string } | undefined;
    return row ? { equityUsd: Number(row.equity_usd), createdAt: row.created_at } : null;
  },

  getLiveInitialBaseline(integrationId: ChainId, fallbackEquityUsd: number) {
    const row = getDatabase().prepare(`
      SELECT equity_usd
      FROM live_daily_baselines
      WHERE integration_id = ?
      ORDER BY date ASC, created_at ASC
      LIMIT 1
    `).get(integrationId) as { equity_usd: number } | undefined;
    return row ? Number(row.equity_usd) : fallbackEquityUsd;
  },

  initializeLiveFundingBaselines(integrationId: ChainId, date: string, equityUsd: number) {
    const database = getDatabase();
    const now = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare(`
        INSERT OR IGNORE INTO live_daily_baselines (integration_id, date, equity_usd, created_at)
        VALUES (?, ?, ?, ?)
      `).run(integrationId, date, equityUsd, now);
      database.prepare(`
        UPDATE live_daily_baselines
        SET equity_usd = ?
        WHERE integration_id = ? AND ABS(equity_usd) <= 0.01
      `).run(equityUsd, integrationId);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  },

  listPositionLots(chainId?: ChainId, tokenAddress?: string, walletId?: string | null): PositionLot[] {
    const clauses: string[] = ["remaining_quantity > 0.000000001"];
    const params: Array<string> = [];
    if (chainId) { clauses.push("chain_id = ?"); params.push(chainId); }
    if (tokenAddress) {
      clauses.push("token_address = ?");
      params.push(normalizeAssetAddress(chainId, tokenAddress));
    }
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
      lot.id, lot.chainId, normalizeAssetAddress(lot.chainId, lot.tokenAddress), lot.tokenSymbol, lot.pairAddress,
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
      tokenAddress: normalizeAssetAddress(chainId, tokenAddress),
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
    const row = getDatabase().prepare("SELECT * FROM positions WHERE chain_id = ? AND token_address = ?")
      .get(chainId, normalizeAssetAddress(chainId, tokenAddress)) as Record<string, unknown> | undefined;
    return row ? mapPosition(row) : null;
  },

  replacePositionAssetAddress(chainId: ChainId, currentAddress: string, canonicalAddress: string) {
    const current = normalizeAssetAddress(chainId, currentAddress);
    const canonical = normalizeAssetAddress(chainId, canonicalAddress);
    if (current === canonical) return;
    const database = getDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("UPDATE trades SET token_address = ? WHERE chain_id = ? AND token_address = ?")
        .run(canonical, chainId, current);
      database.prepare("UPDATE position_lots SET token_address = ? WHERE chain_id = ? AND token_address = ?")
        .run(canonical, chainId, current);
      database.prepare("UPDATE positions SET token_address = ? WHERE chain_id = ? AND token_address = ?")
        .run(canonical, chainId, current);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
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
      normalizeAssetAddress(position.chainId, position.tokenAddress),
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

  getEvent(id: string): AuditEvent | null {
    const row = getDatabase().prepare("SELECT * FROM events WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapEvent(row) : null;
  },

  insertEvent(event: AuditEvent) {
    const result = getDatabase().prepare(`
      INSERT OR IGNORE INTO events (id, chain_id, level, type, title, message, tx_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(event.id, event.chainId, event.level, event.type, event.title, event.message, event.txHash, event.createdAt);
    return result.changes > 0;
  },

  enqueueNotification(eventId: string) {
    const now = new Date().toISOString();
    getDatabase().prepare(`
      INSERT OR IGNORE INTO notification_outbox
      (event_id, status, attempts, next_attempt_at, last_error, created_at, updated_at, sent_at)
      VALUES (?, 'pending', 0, ?, NULL, ?, ?, NULL)
    `).run(eventId, now, now, now);
  },

  getNotificationDelivery(eventId: string) {
    return getDatabase().prepare("SELECT * FROM notification_outbox WHERE event_id = ?").get(eventId) as {
      event_id: string; status: "pending" | "sent" | "dead"; attempts: number; next_attempt_at: string;
      last_error: string | null; created_at: string; updated_at: string; sent_at: string | null;
    } | undefined;
  },

  listDueNotificationEventIds(limit = 20): string[] {
    const now = new Date().toISOString();
    return (getDatabase().prepare(`
      SELECT event_id FROM notification_outbox
      WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY next_attempt_at ASC LIMIT ?
    `).all(now, limit) as Array<{ event_id: string }>).map((row) => row.event_id);
  },

  markNotificationSent(eventId: string) {
    const now = new Date().toISOString();
    getDatabase().prepare(`
      UPDATE notification_outbox
      SET status = 'sent', attempts = attempts + 1, last_error = NULL,
          sent_at = ?, updated_at = ?
      WHERE event_id = ? AND status = 'pending'
    `).run(now, now, eventId);
  },

  markNotificationRetry(eventId: string, error: string, nextAttemptAt: string) {
    getDatabase().prepare(`
      UPDATE notification_outbox
      SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?, updated_at = ?
      WHERE event_id = ? AND status = 'pending'
    `).run(error, nextAttemptAt, new Date().toISOString(), eventId);
  },

  markNotificationDead(eventId: string, error: string) {
    getDatabase().prepare(`
      UPDATE notification_outbox
      SET status = 'dead', attempts = attempts + 1, last_error = ?, updated_at = ?
      WHERE event_id = ? AND status = 'pending'
    `).run(error, new Date().toISOString(), eventId);
  },

  getMode: () => getSetting<TradingMode>("mode"),
  getLanguage: () => getSetting<AppLanguage>("language"),
  setLanguage: (value: AppLanguage) => setSetting("language", value),
  setMode: (value: TradingMode) => setSetting("mode", value),
  getStartingBalance: () => getSetting<number>("startingBalanceUsd"),
  getCashBalance: () => getSetting<number>("cashBalanceUsd"),
  setCashBalance: (value: number) => setSetting("cashBalanceUsd", Math.max(0, value)),
  getRiskSettings: () => mergeRiskSettings(getSetting<RiskSettings>("riskSettings")),
  setRiskSettings: (value: RiskSettings) => setSetting("riskSettings", value),
  getCircuitBreaker: () => getSetting<CircuitBreakerState>("circuitBreaker"),
  setCircuitBreaker: (value: CircuitBreakerState) => setSetting("circuitBreaker", value),
  getDailyStartDate: () => getSetting<string>("dailyStartDate"),
  setDailyStartDate: (value: string) => setSetting("dailyStartDate", value),
  getDailyStartEquity: () => getSetting<number>("dailyStartEquityUsd"),
  setDailyStartEquity: (value: number) => setSetting("dailyStartEquityUsd", value),
  getExecutionAccounts: () => {
    try {
      return getSetting<ExecutionAccountAddresses>("executionAccounts");
    } catch {
      const accounts: ExecutionAccountAddresses = { evm: null, solana: null, hyperliquid: null };
      setSetting("executionAccounts", accounts);
      return accounts;
    }
  },
  setExecutionAccounts: (value: ExecutionAccountAddresses) => setSetting("executionAccounts", value),

  getChainCursor(chainId: ChainId): number | null {
    const row = getDatabase().prepare("SELECT cursor FROM chain_cursors WHERE chain_id = ?").get(chainId) as { cursor: number } | undefined;
    return row ? Number(row.cursor) : null;
  },

  getChainCursorState(chainId: ChainId): { cursor: number; updatedAt: string } | null {
    const row = getDatabase().prepare("SELECT cursor, updated_at FROM chain_cursors WHERE chain_id = ?").get(chainId) as { cursor: number; updated_at: string } | undefined;
    return row ? { cursor: Number(row.cursor), updatedAt: row.updated_at } : null;
  },

  setChainCursor(chainId: ChainId, cursor: number) {
    if (!Number.isSafeInteger(cursor) || cursor < 0) return;
    getDatabase().prepare(`
      INSERT INTO chain_cursors (chain_id, cursor, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(chain_id) DO UPDATE SET cursor = MAX(cursor, excluded.cursor), updated_at = excluded.updated_at
    `).run(chainId, cursor, new Date().toISOString());
  },

  claimRuntimeLease(name: string, ownerId: string, ttlMs = 120_000) {
    const now = new Date();
    const updatedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const result = getDatabase().prepare(`
      INSERT INTO runtime_leases (name, owner_id, expires_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        owner_id = excluded.owner_id,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
      WHERE runtime_leases.owner_id = excluded.owner_id
         OR runtime_leases.expires_at < excluded.updated_at
    `).run(name, ownerId, expiresAt, updatedAt);
    return result.changes > 0;
  },

  releaseRuntimeLease(name: string, ownerId: string) {
    return getDatabase().prepare("DELETE FROM runtime_leases WHERE name = ? AND owner_id = ?").run(name, ownerId).changes > 0;
  },

  interruptStaleRuntimeSessions(cutoffAt = new Date(Date.now() - 90_000).toISOString()) {
    const now = new Date().toISOString();
    return getDatabase().prepare(`
      UPDATE runtime_sessions SET status = 'interrupted', stopped_at = ?, details = COALESCE(details, 'Heartbeat sona erdi.')
      WHERE status = 'running' AND last_heartbeat_at < ?
    `).run(now, cutoffAt).changes;
  },

  startRuntimeSession(input: { id: string; mode: TradingMode; processId: number; startedAt: string }) {
    getDatabase().prepare(`
      INSERT INTO runtime_sessions (id, mode, status, process_id, started_at, last_heartbeat_at)
      VALUES (?, ?, 'running', ?, ?, ?)
    `).run(input.id, input.mode, input.processId, input.startedAt, input.startedAt);
  },

  heartbeatRuntimeSession(id: string, at: string) {
    getDatabase().prepare(`UPDATE runtime_sessions SET last_heartbeat_at = ? WHERE id = ? AND status = 'running'`).run(at, id);
  },

  recordRuntimeHeartbeat(sessionId: string, sampledAt: string, gapMs: number) {
    getDatabase().prepare(`
      INSERT OR IGNORE INTO runtime_heartbeats (session_id, sampled_at, gap_ms) VALUES (?, ?, ?)
    `).run(sessionId, sampledAt, Math.max(0, Math.round(gapMs)));
  },

  stopRuntimeSession(id: string, status: "stopped" | "interrupted", details?: string) {
    const now = new Date().toISOString();
    getDatabase().prepare(`
      UPDATE runtime_sessions SET status = ?, stopped_at = ?, last_heartbeat_at = ?, details = COALESCE(?, details)
      WHERE id = ? AND status = 'running'
    `).run(status, now, now, details ?? null, id);
  },

  getRunningShadowSoak() {
    return getDatabase().prepare("SELECT * FROM shadow_soak_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
  },

  getShadowSoak(id: string) {
    return getDatabase().prepare("SELECT * FROM shadow_soak_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  },

  failRunningShadowSoaks(reason: string) {
    const now = new Date().toISOString();
    getDatabase().prepare(`
      UPDATE shadow_soak_runs SET status = 'failed', completed_at = ?, failure_reason = ? WHERE status = 'running'
    `).run(now, reason);
  },

  startShadowSoak(input: { id: string; startedAt: string; targetEndAt: string; baseline: Record<string, unknown> }) {
    getDatabase().prepare(`
      INSERT INTO shadow_soak_runs (id, status, started_at, target_end_at, baseline)
      VALUES (?, 'running', ?, ?, ?)
    `).run(input.id, input.startedAt, input.targetEndAt, JSON.stringify(input.baseline));
  },

  completeShadowSoak(id: string) {
    const now = new Date().toISOString();
    getDatabase().prepare(`
      UPDATE shadow_soak_runs SET status = 'passed', completed_at = ? WHERE id = ? AND status = 'running'
    `).run(now, id);
  },

  finalizeShadowSoak(id: string, status: "passed" | "failed", failureReason: string | null, result: Record<string, unknown>) {
    const now = new Date().toISOString();
    getDatabase().prepare(`
      UPDATE shadow_soak_runs
      SET status = ?, completed_at = ?, failure_reason = ?, result = ?
      WHERE id = ? AND status = 'running'
    `).run(status, now, failureReason, JSON.stringify(result), id);
  },

  recordServiceHealthSamples(soakId: string | null, sampledAt: string, samples: ServiceHealthMetric[]) {
    const insert = getDatabase().prepare(`
      INSERT INTO service_health_samples
      (soak_id, sampled_at, service_id, status, request_count, error_count, cache_hit_count,
       average_latency_ms, consecutive_errors, reconnect_count, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const sample of samples) {
      insert.run(
        soakId, sampledAt, sample.id, sample.status, sample.requestCount, sample.errorCount,
        sample.cacheHitCount, sample.averageLatencyMs, sample.consecutiveErrors,
        sample.reconnectCount, sample.lastError,
      );
    }
  },

  recordPortfolioSnapshots(soakId: string | null, sampledAt: string, snapshots: ShadowPortfolioSummary[]) {
    const insert = getDatabase().prepare(`
      INSERT INTO portfolio_snapshots
      (soak_id, sampled_at, integration_id, equity_usd, cash_balance_usd, realized_pnl_usd,
       unrealized_pnl_usd, position_unrealized_pnl_usd, funding_token_pnl_usd,
       total_costs_usd, open_position_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const snapshot of snapshots) {
      insert.run(
        soakId, sampledAt, snapshot.integrationId, snapshot.equityUsd, snapshot.cashBalanceUsd,
        snapshot.realizedPnlUsd, snapshot.unrealizedPnlUsd, snapshot.positionUnrealizedPnlUsd,
        snapshot.fundingTokenPnlUsd, snapshot.totalCostsUsd, snapshot.openPositionCount,
      );
    }
  },

  listServiceHealthSamples(soakId: string) {
    return getDatabase().prepare(`
      SELECT * FROM service_health_samples WHERE soak_id = ? ORDER BY sampled_at, service_id
    `).all(soakId) as Record<string, unknown>[];
  },

  listPortfolioSnapshots(soakId: string) {
    return getDatabase().prepare(`
      SELECT * FROM portfolio_snapshots WHERE soak_id = ? ORDER BY sampled_at, integration_id
    `).all(soakId) as Record<string, unknown>[];
  },

  listRuntimeHeartbeats(startedAt: string, endedAt: string) {
    return getDatabase().prepare(`
      SELECT * FROM runtime_heartbeats WHERE sampled_at >= ? AND sampled_at <= ? ORDER BY sampled_at
    `).all(startedAt, endedAt) as Record<string, unknown>[];
  },

  getSoakDatabaseCounts(startedAt: string, endedAt: string) {
    const database = getDatabase();
    const grouped = (table: string, field: string, timestampField = "created_at") => database.prepare(`
      SELECT ${field} AS key, COUNT(*) AS count FROM ${table}
      WHERE ${timestampField} >= ? AND ${timestampField} <= ? GROUP BY ${field}
    `).all(startedAt, endedAt) as Array<{ key: string; count: number }>;
    return {
      eventsByLevel: grouped("events", "level"),
      eventsByType: grouped("events", "type"),
      attemptsByStatus: grouped("execution_attempts", "status"),
      attemptsByNetwork: grouped("execution_attempts", "integration_id"),
      notificationsByStatus: grouped("notification_outbox", "status"),
    };
  },
};

function isValidSolanaPublicKey(address: string) {
  try {
    return new PublicKey(address).toBase58() === address;
  } catch {
    return false;
  }
}

function normalizeExecutionAssetKey(integrationId: ChainId, assetKey: string) {
  return integrationId === "solana" ? assetKey.trim() : assetKey.trim().toLowerCase();
}

function mapExecutionLot(row: Record<string, unknown>): ExecutionLot {
  return {
    id: row.id as string,
    integrationId: row.integration_id as ChainId,
    mode: row.mode as ExecutionLot["mode"],
    assetKey: row.asset_key as string,
    walletId: row.wallet_id as string | null,
    source: row.source as ExecutionLot["source"],
    marketType: row.market_type as ExecutionLot["marketType"],
    positionSide: row.position_side as ExecutionLot["positionSide"],
    amount: row.amount as string,
    initialAmount: row.initial_amount as string,
    amountFormat: row.amount_format as ExecutionLot["amountFormat"],
    assetSymbol: row.asset_symbol as string,
    pairAddress: row.pair_address ? String(row.pair_address) : null,
    assetDecimals: Number(row.asset_decimals),
    entryPriceUsd: Number(row.entry_price_usd),
    currentPriceUsd: Number(row.current_price_usd),
    entryCostUsd: Number(row.entry_cost_usd),
    realizedPnlUsd: Number(row.realized_pnl_usd),
    feesUsd: Number(row.fees_usd),
    leverage: Number(row.leverage),
    entryReference: row.entry_reference as string | null,
    status: row.status as ExecutionLot["status"],
    openedAt: row.opened_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapExecutionAttempt(row: Record<string, unknown>): ExecutionAttempt {
  return {
    id: row.id as string, requestId: row.request_id as string, idempotencyKey: String(row.idempotency_key ?? row.request_id), integrationId: row.integration_id as ChainId,
    walletId: row.wallet_id ? String(row.wallet_id) : null,
    mode: row.mode as ExecutionAttempt["mode"], source: row.source as ExecutionAttempt["source"],
    action: row.action as string, asset: row.asset as string, status: row.status as ExecutionAttempt["status"],
    amountIn: row.amount_in as string | null, amountOut: row.amount_out as string | null,
    expectedAmountOut: row.expected_amount_out as string | null, minimumAmountOut: row.minimum_amount_out as string | null,
    quotedPriceUsd: Number(row.quoted_price_usd), slippagePercent: Number(row.slippage_percent),
    priceImpactPercent: Number(row.price_impact_percent), networkFeeUsd: Number(row.network_fee_usd),
    dexFeeUsd: Number(row.dex_fee_usd), availableBalanceUsd: Number(row.available_balance_usd),
    simulationLatencyMs: Number(row.simulation_latency_ms), txHash: row.tx_hash as string | null,
    externalOrderId: row.external_order_id as string | null,
    accountingStatus: (row.accounting_status ?? "pending") as ExecutionAttempt["accountingStatus"],
    reconciliationStatus: (row.reconciliation_status ?? "pending") as ExecutionAttempt["reconciliationStatus"],
    reconciliationDetails: row.reconciliation_details as string | null,
    submittedAt: row.submitted_at as string | null,
    confirmedAt: row.confirmed_at as string | null,
    accountedAt: row.accounted_at as string | null,
    reconciledAt: row.reconciled_at as string | null,
    errorMessage: row.error_message as string | null,
    metadata: safeJson<Record<string, unknown>>(row.metadata as string, {}),
    createdAt: row.created_at as string, updatedAt: row.updated_at as string,
  };
}

function mapShadowAccount(row: Record<string, unknown>): ShadowAccount {
  return {
    integrationId: row.integration_id as ChainId, startingEquityUsd: Number(row.starting_equity_usd),
    cashBalanceUsd: Number(row.cash_balance_usd), realizedPnlUsd: Number(row.realized_pnl_usd),
    fundingTokenSymbol: String(row.funding_token_symbol ?? ""),
    fundingTokenAmount: Number(row.funding_token_amount ?? 0),
    fundingTokenPriceUsd: Number(row.funding_token_price_usd ?? 0),
    totalCostsUsd: Number(row.total_costs_usd), dailyStartEquityUsd: Number(row.daily_start_equity_usd),
    dailyStartDate: row.daily_start_date as string, createdAt: row.created_at as string, updatedAt: row.updated_at as string,
  };
}

function updateLot(lot: ExecutionLot, amount: string, status: ExecutionLot["status"], accounting?: { netProceedsUsd: number; feesUsd: number }, allocationRatio = 0) {
  const initial = lot.amountFormat === "base_units" ? Number(BigInt(lot.initialAmount || "0")) : Number(lot.initialAmount);
  const consumed = lot.amountFormat === "base_units" ? Number(BigInt(lot.amount) - BigInt(amount)) : Number(lot.amount) - Number(amount);
  const costBasisUsd = initial > 0 ? lot.entryCostUsd * consumed / initial : 0;
  const proceeds = accounting ? accounting.netProceedsUsd * allocationRatio : 0;
  getDatabase().prepare(`
    UPDATE execution_lots
    SET amount = ?, status = ?, realized_pnl_usd = realized_pnl_usd + ?,
        fees_usd = fees_usd + ?, updated_at = ?
    WHERE id = ?
  `).run(amount, status, accounting ? proceeds - costBasisUsd : 0, accounting ? accounting.feesUsd * allocationRatio : 0, new Date().toISOString(), lot.id);
}

function safeJson<T>(value: string | null | undefined, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

const clampScore = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
