import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CHAIN_DEFINITIONS, DEFAULT_RISK_SETTINGS, DEFAULT_STARTING_BALANCE_USD } from "@/lib/domain/defaults";

let database: DatabaseSync | null = null;

export function getDatabase(): DatabaseSync {
  if (database) return database;

  const dataDirectory = path.join(process.cwd(), "data");
  mkdirSync(dataDirectory, { recursive: true });
  database = new DatabaseSync(path.join(dataDirectory, "copydesk.db"));
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(database);
  seed(database);
  return database;
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
  `);

  const walletColumns = new Set(
    (db.prepare("PRAGMA table_info(wallets)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!walletColumns.has("pause_reason")) db.exec("ALTER TABLE wallets ADD COLUMN pause_reason TEXT");
  if (!walletColumns.has("addition_context")) db.exec("ALTER TABLE wallets ADD COLUMN addition_context TEXT");
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

function seed(db: DatabaseSync) {
  const now = new Date().toISOString();
  const insertSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  insertSetting.run("mode", JSON.stringify("paper"));
  insertSetting.run("language", JSON.stringify("tr"));
  insertSetting.run("startingBalanceUsd", JSON.stringify(DEFAULT_STARTING_BALANCE_USD));
  insertSetting.run("cashBalanceUsd", JSON.stringify(DEFAULT_STARTING_BALANCE_USD));
  insertSetting.run("riskSettings", JSON.stringify(DEFAULT_RISK_SETTINGS));
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
    (id, name, native_symbol, status, rpc_configured, last_block, latency_ms, error_message, updated_at)
    VALUES (?, ?, ?, 'stopped', 1, NULL, NULL, NULL, ?)
  `);
  for (const chain of Object.values(CHAIN_DEFINITIONS)) {
    insertChain.run(chain.id, chain.name, chain.nativeSymbol, now);
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
