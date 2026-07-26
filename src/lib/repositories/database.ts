import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CHAIN_DEFINITIONS, DEFAULT_RISK_SETTINGS, DEFAULT_STARTING_BALANCE_USD } from "@/lib/domain/defaults";
import type { ChainId, WalletAdditionContext } from "@/lib/domain/types";
import { SHADOW_TEST_BALANCE_USD, SHADOW_TEST_INTEGRATION_IDS } from "@/lib/domain/integrations";

let database: DatabaseSync | null = null;

export function getDatabase(): DatabaseSync {
  if (database) return database;

  const dataDirectory = path.join(process.cwd(), "data");
  mkdirSync(dataDirectory, { recursive: true });
  const databasePath = path.join(dataDirectory, "neraxon.db");
  migrateLegacyDatabase(dataDirectory, databasePath);
  const candidate = new DatabaseSync(databasePath);
  try {
    candidate.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    migrate(candidate);
    seed(candidate);
    performDatabaseMaintenance(candidate, dataDirectory);
    database = candidate;
    return candidate;
  } catch (error) {
    candidate.close();
    throw error;
  }
}

function migrateLegacyDatabase(dataDirectory: string, databasePath: string) {
  if (existsSync(databasePath)) return;

  const legacyPath = path.join(dataDirectory, "copydesk.db");
  if (!existsSync(legacyPath)) return;

  renameSync(legacyPath, databasePath);
  for (const suffix of ["-wal", "-shm"]) {
    const legacySidecar = `${legacyPath}${suffix}`;
    if (existsSync(legacySidecar)) renameSync(legacySidecar, `${databasePath}${suffix}`);
  }
}

function migrate(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chains (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      native_symbol TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'evm',
      status TEXT NOT NULL,
      rpc_configured INTEGER NOT NULL,
      last_block INTEGER,
      latency_ms INTEGER,
      error_message TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallets (
      id TEXT PRIMARY KEY,
      address TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      tracked_chain_ids TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL,
      score INTEGER NOT NULL,
      score_breakdown TEXT NOT NULL,
      total_trades INTEGER NOT NULL DEFAULT 0,
      observation_swap_count INTEGER NOT NULL DEFAULT 0,
      win_rate REAL NOT NULL DEFAULT 0,
      realized_pnl_usd REAL NOT NULL DEFAULT 0,
      max_drawdown_percent REAL NOT NULL DEFAULT 0,
      average_hold_minutes REAL NOT NULL DEFAULT 0,
      pause_reason TEXT,
      addition_context TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      chain_id TEXT NOT NULL,
      wallet_id TEXT,
      source TEXT NOT NULL,
      side TEXT NOT NULL,
      token_address TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      quantity REAL NOT NULL,
      price_usd REAL NOT NULL,
      gross_usd REAL NOT NULL,
      net_usd REAL NOT NULL,
      status TEXT NOT NULL,
      fees TEXT NOT NULL,
      reason TEXT NOT NULL,
      tx_hash TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY,
      chain_id TEXT NOT NULL,
      token_address TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      source_wallet_id TEXT,
      source_wallet_label TEXT,
      quantity REAL NOT NULL,
      average_entry_usd REAL NOT NULL,
      current_price_usd REAL NOT NULL,
      invested_usd REAL NOT NULL,
      unrealized_pnl_usd REAL NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(chain_id, token_address)
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      chain_id TEXT,
      level TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      tx_hash TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notification_outbox (
      event_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sent_at TEXT,
      FOREIGN KEY (event_id) REFERENCES events(id)
    );
    CREATE INDEX IF NOT EXISTS idx_notification_outbox_due
      ON notification_outbox(status, next_attempt_at);
    CREATE TABLE IF NOT EXISTS chain_cursors (
      chain_id TEXT PRIMARY KEY,
      cursor INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_sessions (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      process_id INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL,
      stopped_at TEXT,
      details TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_sessions_started
      ON runtime_sessions(started_at DESC);
    CREATE TABLE IF NOT EXISTS runtime_leases (
      name TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shadow_soak_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      target_end_at TEXT NOT NULL,
      completed_at TEXT,
      failure_reason TEXT,
      baseline TEXT NOT NULL,
      result TEXT
    );
    CREATE TABLE IF NOT EXISTS runtime_heartbeats (
      session_id TEXT NOT NULL,
      sampled_at TEXT NOT NULL,
      gap_ms INTEGER NOT NULL,
      PRIMARY KEY (session_id, sampled_at),
      FOREIGN KEY (session_id) REFERENCES runtime_sessions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_heartbeats_sampled
      ON runtime_heartbeats(sampled_at);
    CREATE TABLE IF NOT EXISTS service_health_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      soak_id TEXT,
      sampled_at TEXT NOT NULL,
      service_id TEXT NOT NULL,
      status TEXT NOT NULL,
      request_count INTEGER NOT NULL,
      error_count INTEGER NOT NULL,
      cache_hit_count INTEGER NOT NULL,
      average_latency_ms INTEGER NOT NULL,
      consecutive_errors INTEGER NOT NULL,
      reconnect_count INTEGER NOT NULL,
      last_error TEXT,
      FOREIGN KEY (soak_id) REFERENCES shadow_soak_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_service_health_samples_soak
      ON service_health_samples(soak_id, sampled_at, service_id);
    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      soak_id TEXT,
      sampled_at TEXT NOT NULL,
      integration_id TEXT NOT NULL,
      equity_usd REAL NOT NULL,
      cash_balance_usd REAL NOT NULL,
      realized_pnl_usd REAL NOT NULL,
      unrealized_pnl_usd REAL NOT NULL,
      position_unrealized_pnl_usd REAL NOT NULL,
      funding_token_pnl_usd REAL NOT NULL,
      total_costs_usd REAL NOT NULL,
      open_position_count INTEGER NOT NULL,
      FOREIGN KEY (soak_id) REFERENCES shadow_soak_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_soak
      ON portfolio_snapshots(soak_id, sampled_at, integration_id);
    CREATE TABLE IF NOT EXISTS copy_buy_signals (
      chain_id TEXT NOT NULL,
      token_address TEXT NOT NULL,
      wallet_id TEXT NOT NULL,
      first_tx_hash TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (chain_id, token_address, wallet_id)
    );
    CREATE TABLE IF NOT EXISTS copy_buy_consensus (
      chain_id TEXT NOT NULL,
      token_address TEXT NOT NULL,
      copied_stages INTEGER NOT NULL DEFAULT 0,
      pending_stage INTEGER,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (chain_id, token_address)
    );
    CREATE TABLE IF NOT EXISTS ai_trade_advisories (
      id TEXT PRIMARY KEY,
      chain_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      side TEXT NOT NULL,
      asset TEXT NOT NULL,
      wallet_id TEXT,
      wallet_label TEXT,
      source_reference TEXT NOT NULL,
      recommendation TEXT NOT NULL,
      confidence REAL NOT NULL,
      risk_level TEXT NOT NULL,
      summary_tr TEXT NOT NULL,
      summary_en TEXT NOT NULL,
      project_purpose_tr TEXT NOT NULL DEFAULT '',
      project_purpose_en TEXT NOT NULL DEFAULT '',
      social_assessment_tr TEXT NOT NULL DEFAULT '',
      social_assessment_en TEXT NOT NULL DEFAULT '',
      research_sources TEXT NOT NULL DEFAULT '[]',
      risk_flags_tr TEXT NOT NULL,
      risk_flags_en TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_trade_advisories_created
      ON ai_trade_advisories(created_at DESC);
    CREATE TABLE IF NOT EXISTS ai_request_usage (
      id TEXT PRIMARY KEY,
      purpose TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_request_usage_created
      ON ai_request_usage(created_at DESC);
    CREATE TABLE IF NOT EXISTS social_token_signals (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      chat_title TEXT NOT NULL,
      message_id TEXT NOT NULL,
      chain_id TEXT,
      dexscreener_chain_id TEXT,
      token_address TEXT,
      token_symbol TEXT,
      ticker TEXT,
      reference_type TEXT NOT NULL,
      status TEXT NOT NULL,
      price_usd REAL NOT NULL DEFAULT 0,
      liquidity_usd REAL NOT NULL DEFAULT 0,
      volume_24h_usd REAL NOT NULL DEFAULT 0,
      price_change_24h_percent REAL NOT NULL DEFAULT 0,
      market_cap_usd REAL,
      pair_address TEXT,
      error_message TEXT,
      resolver_version TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_social_token_signal_source
      ON social_token_signals(chat_id, message_id, reference_type, COALESCE(token_address, ''), COALESCE(ticker, ''));
    CREATE INDEX IF NOT EXISTS idx_social_token_signals_created
      ON social_token_signals(created_at DESC);
    CREATE TABLE IF NOT EXISTS position_lots (
      id TEXT PRIMARY KEY,
      chain_id TEXT NOT NULL,
      token_address TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      pair_address TEXT,
      wallet_id TEXT,
      wallet_label TEXT,
      source TEXT NOT NULL,
      opened_trade_id TEXT,
      initial_quantity REAL NOT NULL,
      remaining_quantity REAL NOT NULL,
      entry_price_usd REAL NOT NULL,
      entry_cost_usd REAL NOT NULL,
      realized_pnl_usd REAL NOT NULL DEFAULT 0,
      opened_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_position_lots_open
      ON position_lots (chain_id, token_address, wallet_id, remaining_quantity);
    CREATE TABLE IF NOT EXISTS wallet_swap_activity (
      chain_id TEXT NOT NULL,
      wallet_id TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (chain_id, tx_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_swap_activity_window
      ON wallet_swap_activity (wallet_id, observed_at);
    CREATE INDEX IF NOT EXISTS idx_wallet_swap_activity_network_window
      ON wallet_swap_activity (wallet_id, chain_id, observed_at);
    CREATE TABLE IF NOT EXISTS hypercore_positions (
      id TEXT PRIMARY KEY,
      wallet_id TEXT,
      wallet_label TEXT,
      coin TEXT NOT NULL,
      market_type TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity REAL NOT NULL,
      entry_price_usd REAL NOT NULL,
      current_price_usd REAL NOT NULL,
      margin_usd REAL NOT NULL,
      leverage REAL NOT NULL,
      liquidation_price_usd REAL,
      unrealized_pnl_usd REAL NOT NULL DEFAULT 0,
      funding_usd REAL NOT NULL DEFAULT 0,
      opened_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(wallet_id, coin, market_type, side)
    );
    CREATE TABLE IF NOT EXISTS hypercore_trades (
      id TEXT PRIMARY KEY,
      wallet_id TEXT,
      source TEXT NOT NULL,
      coin TEXT NOT NULL,
      market_type TEXT NOT NULL,
      side TEXT NOT NULL,
      position_side TEXT NOT NULL,
      action TEXT NOT NULL,
      quantity REAL NOT NULL,
      price_usd REAL NOT NULL,
      notional_usd REAL NOT NULL,
      margin_usd REAL NOT NULL,
      leverage REAL NOT NULL,
      fee_usd REAL NOT NULL,
      funding_usd REAL NOT NULL DEFAULT 0,
      realized_pnl_usd REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      source_fill_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hypercore_source_fill
      ON hypercore_trades(source_fill_id) WHERE source_fill_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS execution_attempts (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      integration_id TEXT NOT NULL,
      wallet_id TEXT,
      mode TEXT NOT NULL,
      source TEXT NOT NULL,
      action TEXT NOT NULL,
      asset TEXT NOT NULL,
      status TEXT NOT NULL,
      amount_in TEXT,
      amount_out TEXT,
      tx_hash TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_execution_attempts_created
      ON execution_attempts(created_at DESC);
    CREATE TABLE IF NOT EXISTS execution_lots (
      id TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      asset_key TEXT NOT NULL,
      wallet_id TEXT,
      source TEXT NOT NULL,
      market_type TEXT NOT NULL,
      position_side TEXT,
      amount TEXT NOT NULL,
      initial_amount TEXT NOT NULL DEFAULT '0',
      amount_format TEXT NOT NULL,
      asset_symbol TEXT NOT NULL DEFAULT '',
      asset_decimals INTEGER NOT NULL DEFAULT 0,
      entry_price_usd REAL NOT NULL DEFAULT 0,
      current_price_usd REAL NOT NULL DEFAULT 0,
      entry_cost_usd REAL NOT NULL DEFAULT 0,
      realized_pnl_usd REAL NOT NULL DEFAULT 0,
      fees_usd REAL NOT NULL DEFAULT 0,
      leverage REAL NOT NULL DEFAULT 1,
      entry_reference TEXT,
      status TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_execution_lots_owner
      ON execution_lots(integration_id, mode, asset_key, wallet_id, status);
    CREATE TABLE IF NOT EXISTS live_reconciliation (
      integration_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      details TEXT NOT NULL,
      checked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS live_certification_steps (
      integration_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      status TEXT NOT NULL,
      reference TEXT,
      details TEXT NOT NULL,
      checked_at TEXT,
      PRIMARY KEY (integration_id, step_id)
    );
    CREATE TABLE IF NOT EXISTS execution_copy_signals (
      mode TEXT NOT NULL,
      integration_id TEXT NOT NULL,
      asset_key TEXT NOT NULL,
      wallet_id TEXT NOT NULL,
      first_reference TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (mode, integration_id, asset_key, wallet_id)
    );
    CREATE TABLE IF NOT EXISTS execution_copy_consensus (
      mode TEXT NOT NULL,
      integration_id TEXT NOT NULL,
      asset_key TEXT NOT NULL,
      copied_stages INTEGER NOT NULL DEFAULT 0,
      pending_stage INTEGER,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (mode, integration_id, asset_key)
    );
    CREATE TABLE IF NOT EXISTS live_daily_baselines (
      integration_id TEXT NOT NULL,
      date TEXT NOT NULL,
      equity_usd REAL NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (integration_id, date)
    );
    CREATE TABLE IF NOT EXISTS shadow_accounts (
      integration_id TEXT PRIMARY KEY,
      starting_equity_usd REAL NOT NULL,
      cash_balance_usd REAL NOT NULL,
      realized_pnl_usd REAL NOT NULL DEFAULT 0,
      total_costs_usd REAL NOT NULL DEFAULT 0,
      daily_start_equity_usd REAL NOT NULL,
      daily_start_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS paper_periods (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      starting_balance_usd REAL NOT NULL,
      ending_equity_usd REAL NOT NULL,
      realized_pnl_usd REAL NOT NULL,
      unrealized_pnl_usd REAL NOT NULL,
      total_costs_usd REAL NOT NULL,
      confirmed_trade_count INTEGER NOT NULL,
      open_position_count INTEGER NOT NULL,
      snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  ensureColumns(db, "ai_trade_advisories", {
    summary: "TEXT NOT NULL DEFAULT ''",
    risk_flags: "TEXT NOT NULL DEFAULT '[]'",
    summary_tr: "TEXT NOT NULL DEFAULT ''",
    summary_en: "TEXT NOT NULL DEFAULT ''",
    project_purpose_tr: "TEXT NOT NULL DEFAULT ''",
    project_purpose_en: "TEXT NOT NULL DEFAULT ''",
    social_assessment_tr: "TEXT NOT NULL DEFAULT ''",
    social_assessment_en: "TEXT NOT NULL DEFAULT ''",
    research_sources: "TEXT NOT NULL DEFAULT '[]'",
    risk_flags_tr: "TEXT NOT NULL DEFAULT '[]'",
    risk_flags_en: "TEXT NOT NULL DEFAULT '[]'",
  });

  ensureColumns(db, "social_token_signals", {
    dexscreener_chain_id: "TEXT",
    resolver_version: "TEXT",
  });

  ensureColumns(db, "execution_attempts", {
    wallet_id: "TEXT",
    idempotency_key: "TEXT",
    expected_amount_out: "TEXT",
    minimum_amount_out: "TEXT",
    quoted_price_usd: "REAL NOT NULL DEFAULT 0",
    slippage_percent: "REAL NOT NULL DEFAULT 0",
    price_impact_percent: "REAL NOT NULL DEFAULT 0",
    network_fee_usd: "REAL NOT NULL DEFAULT 0",
    dex_fee_usd: "REAL NOT NULL DEFAULT 0",
    available_balance_usd: "REAL NOT NULL DEFAULT 0",
    simulation_latency_ms: "INTEGER NOT NULL DEFAULT 0",
    metadata: "TEXT NOT NULL DEFAULT '{}'",
    external_order_id: "TEXT",
    accounting_status: "TEXT NOT NULL DEFAULT 'pending'",
    reconciliation_status: "TEXT NOT NULL DEFAULT 'pending'",
    reconciliation_details: "TEXT",
    submitted_at: "TEXT",
    confirmed_at: "TEXT",
    accounted_at: "TEXT",
    reconciled_at: "TEXT",
  });
  db.exec("UPDATE execution_attempts SET idempotency_key = request_id WHERE idempotency_key IS NULL");
  db.exec("UPDATE execution_attempts SET accounting_status = 'applied', accounted_at = COALESCE(accounted_at, updated_at) WHERE status IN ('simulated', 'confirmed')");
  db.exec("UPDATE execution_attempts SET reconciliation_status = 'passed', reconciled_at = COALESCE(reconciled_at, updated_at) WHERE mode = 'shadow' AND status = 'simulated'");
  db.exec("UPDATE execution_attempts SET external_order_id = substr(tx_hash, 13) WHERE integration_id = 'hyperliquid' AND external_order_id IS NULL AND tx_hash LIKE 'hyperliquid:%'");
  db.exec(`
    UPDATE execution_attempts SET
      status = 'filtered',
      reconciliation_status = 'passed',
      reconciliation_details = 'Emir yürütme öncesinde filtrelendi; ağa veya borsaya gönderim yapılmadı.',
      reconciled_at = COALESCE(reconciled_at, updated_at)
    WHERE status = 'failed' AND tx_hash IS NULL AND submitted_at IS NULL AND (
      lower(COALESCE(error_message, '')) LIKE '%likidite%'
      OR lower(COALESCE(error_message, '')) LIKE '%liquidity%'
      OR lower(COALESCE(error_message, '')) LIKE '%rota%bulunamad%'
      OR lower(COALESCE(error_message, '')) LIKE '%no route%'
      OR lower(COALESCE(error_message, '')) LIKE '%legal restriction%'
      OR lower(COALESCE(error_message, '')) LIKE '%denylist%'
      OR lower(COALESCE(error_message, '')) LIKE '%güvenlik skoru%'
      OR lower(COALESCE(error_message, '')) LIKE '%price deviation%'
      OR lower(COALESCE(error_message, '')) LIKE '%fiyat sapması%'
      OR lower(COALESCE(error_message, '')) LIKE '%slippage%aşıyor%'
      OR lower(COALESCE(error_message, '')) LIKE '%fee % sınırını aşıyor%'
      OR lower(COALESCE(error_message, '')) LIKE '%en az % usd olmalı%'
      OR lower(COALESCE(error_message, '')) LIKE '%işlem tavanını aşıyor%'
      OR lower(COALESCE(error_message, '')) LIKE '%işlem % sınırını aşıyor%'
      OR lower(COALESCE(error_message, '')) LIKE '%maruziyet sınırı aşılacak%'
      OR lower(COALESCE(error_message, '')) LIKE '%açık pozisyon sınırına ulaştı%'
      OR lower(COALESCE(error_message, '')) LIKE '%günlük canlı zarar oranı % sınırına ulaştı%'
      OR lower(COALESCE(error_message, '')) LIKE '%devre kesici aktifken canlı emir gönderilemez%'
      OR lower(COALESCE(error_message, '')) LIKE '%gas rezervi sonrasında kullanılabilir eth yok%'
      OR lower(COALESCE(error_message, '')) LIKE '%kullanılabilir teminatı minimum emir için yetersiz%'
      OR lower(COALESCE(error_message, '')) LIKE '%tick kurallarıyla karşılamıyor%'
      OR lower(COALESCE(error_message, '')) LIKE '%allowlist%değil%'
      OR lower(COALESCE(error_message, '')) LIKE '%piyasası bulunamadı%'
      OR lower(COALESCE(error_message, '')) LIKE '%doğrulanabilir % havuzu bulunamadı%'
      OR lower(COALESCE(error_message, '')) LIKE '%hooks kullanan % havuzları % izinli değil%'
      OR lower(COALESCE(error_message, '')) LIKE '%quoteexactinputsingle%revert%'
      OR lower(COALESCE(error_message, '')) LIKE '%rota simülasyonu başarısız%'
      OR lower(COALESCE(error_message, '')) LIKE 'execution reverted%'
    )
  `);
  db.exec(`
    UPDATE execution_attempts SET
      reconciliation_status = 'passed',
      reconciliation_details = COALESCE(reconciliation_details, 'Emir yürütme öncesinde filtrelendi; ağa veya borsaya gönderim yapılmadı.'),
      reconciled_at = COALESCE(reconciled_at, updated_at)
    WHERE status = 'filtered' AND tx_hash IS NULL AND submitted_at IS NULL
  `);
  db.exec(`
    UPDATE events SET level = 'info'
    WHERE level = 'critical' AND type = 'swap' AND (
      lower(title) LIKE '%tamamlandı%'
      OR lower(title) LIKE '%copy trade%'
      OR title = 'Canlı hazırlık testi geçti'
    )
  `);
  db.exec(`
    UPDATE execution_attempts
    SET wallet_id = (
      SELECT MIN(lots.wallet_id)
      FROM execution_lots AS lots
      WHERE lots.wallet_id IS NOT NULL
        AND lots.source = 'copy'
        AND lots.mode = execution_attempts.mode
        AND lots.integration_id = execution_attempts.integration_id
        AND (lower(lots.asset_symbol) = lower(execution_attempts.asset) OR execution_attempts.request_id LIKE '%' || lots.entry_reference)
      HAVING COUNT(DISTINCT lots.wallet_id) = 1
    )
    WHERE wallet_id IS NULL AND source = 'copy'
  `);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_attempts_idempotency ON execution_attempts(idempotency_key) WHERE idempotency_key IS NOT NULL");
  ensureColumns(db, "execution_lots", {
    initial_amount: "TEXT NOT NULL DEFAULT '0'",
    asset_symbol: "TEXT NOT NULL DEFAULT ''",
    asset_decimals: "INTEGER NOT NULL DEFAULT 0",
    entry_price_usd: "REAL NOT NULL DEFAULT 0",
    current_price_usd: "REAL NOT NULL DEFAULT 0",
    entry_cost_usd: "REAL NOT NULL DEFAULT 0",
    realized_pnl_usd: "REAL NOT NULL DEFAULT 0",
    fees_usd: "REAL NOT NULL DEFAULT 0",
    leverage: "REAL NOT NULL DEFAULT 1",
  });
  ensureColumns(db, "shadow_accounts", {
    funding_token_symbol: "TEXT NOT NULL DEFAULT ''",
    funding_token_amount: "REAL NOT NULL DEFAULT 0",
    funding_token_price_usd: "REAL NOT NULL DEFAULT 0",
  });
  ensureColumns(db, "shadow_soak_runs", {
    result: "TEXT",
  });
  db.exec("UPDATE execution_lots SET initial_amount = amount WHERE initial_amount = '0'");

  const chainColumns = new Set(
    (db.prepare("PRAGMA table_info(chains)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!chainColumns.has("kind")) db.exec("ALTER TABLE chains ADD COLUMN kind TEXT NOT NULL DEFAULT 'evm'");

  const walletColumns = new Set(
    (db.prepare("PRAGMA table_info(wallets)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!walletColumns.has("pause_reason")) db.exec("ALTER TABLE wallets ADD COLUMN pause_reason TEXT");
  if (!walletColumns.has("addition_context")) db.exec("ALTER TABLE wallets ADD COLUMN addition_context TEXT");
  if (!walletColumns.has("is_favorite")) db.exec("ALTER TABLE wallets ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0");
  if (!walletColumns.has("tracked_chain_ids")) {
    db.exec("ALTER TABLE wallets ADD COLUMN tracked_chain_ids TEXT NOT NULL DEFAULT '[]'");
    const supportedChainIds = Object.keys(CHAIN_DEFINITIONS) as ChainId[];
    const rows = db.prepare("SELECT id, addition_context FROM wallets").all() as Array<{ id: string; addition_context: string | null }>;
    const update = db.prepare("UPDATE wallets SET tracked_chain_ids = ? WHERE id = ?");
    for (const row of rows) {
      let trackedChainIds = supportedChainIds;
      if (row.addition_context) {
        try {
          const context = JSON.parse(row.addition_context) as WalletAdditionContext;
          if (context.chainId && supportedChainIds.includes(context.chainId)) trackedChainIds = [context.chainId];
        } catch {
          // Eski kayıt okunamıyorsa önceki tüm-ağ davranışı korunur.
        }
      }
      update.run(JSON.stringify(trackedChainIds), row.id);
    }
  }
  repairLegacyDiscoveryNetworkScope(db);
  if (!walletColumns.has("observation_swap_count")) {
    db.exec(`
      ALTER TABLE wallets ADD COLUMN observation_swap_count INTEGER NOT NULL DEFAULT 0;
      UPDATE wallets
      SET observation_swap_count = CASE
        WHEN state = 'observing' THEN total_trades
        WHEN total_trades > 10 THEN 10
        ELSE total_trades
      END;
    `);
  }

  const tradeColumns = new Set(
    (db.prepare("PRAGMA table_info(trades)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!tradeColumns.has("realized_pnl_usd")) db.exec("ALTER TABLE trades ADD COLUMN realized_pnl_usd REAL NOT NULL DEFAULT 0");
  if (!tradeColumns.has("execution_delay_ms")) db.exec("ALTER TABLE trades ADD COLUMN execution_delay_ms INTEGER NOT NULL DEFAULT 0");

  const positionColumns = new Set(
    (db.prepare("PRAGMA table_info(positions)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!positionColumns.has("source_wallet_id")) db.exec("ALTER TABLE positions ADD COLUMN source_wallet_id TEXT");
  if (!positionColumns.has("source_wallet_label")) db.exec("ALTER TABLE positions ADD COLUMN source_wallet_label TEXT");
  if (!positionColumns.has("pair_address")) db.exec("ALTER TABLE positions ADD COLUMN pair_address TEXT");
  db.exec(`
    INSERT OR IGNORE INTO wallet_swap_activity (chain_id, wallet_id, tx_hash, observed_at)
    SELECT chain_id, wallet_id, LOWER(tx_hash), created_at
    FROM trades
    WHERE source = 'copy' AND wallet_id IS NOT NULL AND tx_hash IS NOT NULL;

    UPDATE positions
    SET source_wallet_id = (
      SELECT trades.wallet_id FROM trades
      WHERE trades.chain_id = positions.chain_id
        AND LOWER(trades.token_address) = LOWER(positions.token_address)
        AND trades.source = 'copy'
        AND trades.side = 'buy'
        AND trades.status = 'confirmed'
        AND trades.wallet_id IS NOT NULL
      ORDER BY trades.created_at ASC
      LIMIT 1
    )
    WHERE source_wallet_id IS NULL;

    UPDATE positions
    SET source_wallet_label = (
      SELECT wallets.label FROM wallets WHERE wallets.id = positions.source_wallet_id
    )
    WHERE source_wallet_id IS NOT NULL AND source_wallet_label IS NULL;

    INSERT OR IGNORE INTO copy_buy_signals (chain_id, token_address, wallet_id, first_tx_hash, created_at)
    SELECT chain_id, LOWER(token_address), wallet_id, MIN(tx_hash), MIN(created_at)
    FROM trades
    WHERE source = 'copy' AND side = 'buy' AND status = 'confirmed' AND wallet_id IS NOT NULL
    GROUP BY chain_id, LOWER(token_address), wallet_id;

    INSERT OR IGNORE INTO copy_buy_consensus (chain_id, token_address, copied_stages, pending_stage, updated_at)
    SELECT chain_id, LOWER(token_address), 1, NULL, MAX(created_at)
    FROM trades
    WHERE source = 'copy' AND side = 'buy' AND status = 'confirmed'
    GROUP BY chain_id, LOWER(token_address);

    UPDATE copy_buy_consensus SET pending_stage = NULL WHERE pending_stage IS NOT NULL;

    INSERT INTO position_lots
    (id, chain_id, token_address, token_symbol, pair_address, wallet_id, wallet_label, source, opened_trade_id, initial_quantity, remaining_quantity, entry_price_usd, entry_cost_usd, realized_pnl_usd, opened_at, updated_at)
    SELECT
      'legacy-' || positions.id,
      positions.chain_id,
      LOWER(positions.token_address),
      positions.token_symbol,
      positions.pair_address,
      positions.source_wallet_id,
      positions.source_wallet_label,
      CASE WHEN positions.source_wallet_id IS NULL THEN 'manual' ELSE 'copy' END,
      NULL,
      positions.quantity,
      positions.quantity,
      positions.average_entry_usd,
      positions.invested_usd,
      0,
      positions.updated_at,
      positions.updated_at
    FROM positions
    WHERE positions.quantity > 0
      AND NOT EXISTS (
        SELECT 1 FROM position_lots
        WHERE position_lots.chain_id = positions.chain_id
          AND position_lots.token_address = LOWER(positions.token_address)
      );
  `);
}

function ensureColumns(db: DatabaseSync, table: string, columns: Record<string, string>) {
  const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

function repairLegacyDiscoveryNetworkScope(db: DatabaseSync) {
  const supportedChainIds = Object.keys(CHAIN_DEFINITIONS) as ChainId[];
  const legacyAllNetworks = JSON.stringify(supportedChainIds);
  const networkByLabel = new Map<string, ChainId>([
    ["Ethereum", "ethereum"],
    ["Base", "base"],
    ["Robinhood", "robinhood"],
    ["Hyperliquid", "hyperliquid"],
  ]);
  const rows = db.prepare(`
    SELECT id, label FROM wallets
    WHERE addition_context IS NULL AND tracked_chain_ids = ? AND label LIKE '% keşif · %'
  `).all(legacyAllNetworks) as Array<{ id: string; label: string }>;
  const update = db.prepare("UPDATE wallets SET tracked_chain_ids = ?, updated_at = ? WHERE id = ?");
  const now = new Date().toISOString();
  for (const row of rows) {
    const networkLabel = row.label.match(/^(.+?) keşif · /u)?.[1];
    const chainId = networkLabel ? networkByLabel.get(networkLabel) : undefined;
    if (chainId) update.run(JSON.stringify([chainId]), now, row.id);
  }
}

function seed(db: DatabaseSync) {
  const now = new Date().toISOString();
  const insertSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  insertSetting.run("mode", JSON.stringify("live"));
  db.prepare("UPDATE settings SET value = ? WHERE key = 'mode' AND value != ?")
    .run(JSON.stringify("live"), JSON.stringify("live"));
  insertSetting.run("language", JSON.stringify("tr"));
  insertSetting.run("startingBalanceUsd", JSON.stringify(DEFAULT_STARTING_BALANCE_USD));
  insertSetting.run("cashBalanceUsd", JSON.stringify(DEFAULT_STARTING_BALANCE_USD));
  insertSetting.run("executionAccounts", JSON.stringify({ evm: null, solana: null, hyperliquid: null }));
  insertSetting.run("riskSettings", JSON.stringify(DEFAULT_RISK_SETTINGS));
  const shadowAllocationMigrationKey = "migration.shadowTestAllocationV1";
  const shadowAllocationMigrated = db.prepare("SELECT 1 FROM settings WHERE key = ?").get(shadowAllocationMigrationKey);
  const modeRow = db.prepare("SELECT value FROM settings WHERE key = 'mode'").get() as { value: string };
  const shadowLotCount = (db.prepare("SELECT COUNT(*) AS count FROM execution_lots WHERE mode = 'shadow'").get() as { count: number }).count;
  if (!shadowAllocationMigrated && modeRow.value === JSON.stringify("shadow") && shadowLotCount === 0) {
    db.exec("DELETE FROM shadow_accounts");
    const insertShadowAccount = db.prepare(`
      INSERT INTO shadow_accounts
      (integration_id, starting_equity_usd, cash_balance_usd, realized_pnl_usd, total_costs_usd,
       daily_start_equity_usd, daily_start_date, created_at, updated_at)
      VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?)
    `);
    const date = now.slice(0, 10);
    for (const chainId of SHADOW_TEST_INTEGRATION_IDS) {
      insertShadowAccount.run(chainId, SHADOW_TEST_BALANCE_USD, SHADOW_TEST_BALANCE_USD, SHADOW_TEST_BALANCE_USD, date, now, now);
    }
    insertSetting.run(shadowAllocationMigrationKey, JSON.stringify(true));
  }
  const swapLimitMigrationKey = "migration.walletSwapLimit50";
  const swapLimitMigrated = db.prepare("SELECT 1 FROM settings WHERE key = ?").get(swapLimitMigrationKey);
  if (!swapLimitMigrated) {
    const riskRow = db.prepare("SELECT value FROM settings WHERE key = 'riskSettings'").get() as { value: string };
    const riskSettings = JSON.parse(riskRow.value) as Record<string, unknown>;
    riskSettings.maxWalletSwapsPer24Hours = 50;
    db.prepare("UPDATE settings SET value = ? WHERE key = 'riskSettings'").run(JSON.stringify(riskSettings));
    insertSetting.run(swapLimitMigrationKey, JSON.stringify(true));
  }
  const walletScoreThresholdMigrationKey = "migration.walletScoreThreshold65";
  const walletScoreThresholdMigrated = db.prepare("SELECT 1 FROM settings WHERE key = ?").get(walletScoreThresholdMigrationKey);
  if (!walletScoreThresholdMigrated) {
    db.exec("UPDATE wallets SET state = 'observing' WHERE state = 'active' AND score < 65");
    insertSetting.run(walletScoreThresholdMigrationKey, JSON.stringify(true));
  }
  const scoreIndependentCopyMigrationKey = "migration.scoreIndependentCopy";
  const scoreIndependentCopyMigrated = db.prepare("SELECT 1 FROM settings WHERE key = ?").get(scoreIndependentCopyMigrationKey);
  if (!scoreIndependentCopyMigrated) {
    db.exec("UPDATE wallets SET state = 'active' WHERE state = 'observing' AND total_trades >= 10");
    insertSetting.run(scoreIndependentCopyMigrationKey, JSON.stringify(true));
  }
  insertSetting.run("dailyStartDate", JSON.stringify(new Date().toISOString().slice(0, 10)));
  insertSetting.run("dailyStartEquityUsd", JSON.stringify(DEFAULT_STARTING_BALANCE_USD));
  insertSetting.run("circuitBreaker", JSON.stringify({
    halted: false,
    reason: null,
    consecutiveFailures: 0,
    triggeredAt: null,
    updatedAt: now,
  }));

  const insertChain = db.prepare(`
    INSERT OR IGNORE INTO chains
    (id, name, native_symbol, kind, status, rpc_configured, last_block, latency_ms, error_message, updated_at)
    VALUES (?, ?, ?, ?, 'stopped', 1, NULL, NULL, NULL, ?)
  `);
  for (const chain of Object.values(CHAIN_DEFINITIONS)) {
    insertChain.run(chain.id, chain.name, chain.nativeSymbol, chain.kind, now);
    db.prepare("UPDATE chains SET name = ?, native_symbol = ?, kind = ?, rpc_configured = 1 WHERE id = ?")
      .run(chain.name, chain.nativeSymbol, chain.kind, chain.id);
  }
  db.prepare(`
    UPDATE chains
    SET status = 'stopped', error_message = NULL, updated_at = ?
    WHERE status IN ('starting', 'stopping')
  `).run(now);

  const eventCount = Number((db.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number }).count);
  if (eventCount === 0) {
    db.prepare(`
      INSERT INTO events (id, chain_id, level, type, title, message, tx_hash, created_at)
      VALUES (?, NULL, 'info', 'system', ?, ?, NULL, ?)
    `).run(
      crypto.randomUUID(),
      "Paper çalışma alanı hazır",
      "100 USD başlangıç bakiyesi ve varsayılan risk kuralları oluşturuldu.",
      now,
    );
  }
}

function performDatabaseMaintenance(db: DatabaseSync, dataDirectory: string) {
  const integrity = db.prepare("PRAGMA quick_check").get() as { quick_check: string };
  if (integrity.quick_check !== "ok") throw new Error(`SQLite bütünlük kontrolü başarısız: ${integrity.quick_check}`);
  db.exec("PRAGMA wal_checkpoint(PASSIVE)");

  const backupDirectory = path.join(dataDirectory, "backups");
  mkdirSync(backupDirectory, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const backupName = `neraxon-${today}.db`;
  const backupPath = path.join(backupDirectory, backupName);
  if (!existsSync(backupPath)) {
    const escapedPath = backupPath.replaceAll("'", "''");
    db.exec(`VACUUM INTO '${escapedPath}'`);
  }

  const backups = readdirSync(backupDirectory)
    .filter((name) => /^neraxon-\d{4}-\d{2}-\d{2}\.db$/.test(name))
    .sort()
    .reverse();
  for (const expired of backups.slice(14)) unlinkSync(path.join(backupDirectory, expired));
}

export function getSetting<T>(key: string): T {
  const row = getDatabase().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) throw new Error(`Ayar bulunamadı: ${key}`);
  return JSON.parse(row.value) as T;
}

export function setSetting(key: string, value: unknown) {
  getDatabase()
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(value));
}
