-- SQLite schema. Applied automatically on startup by src/db/pool.js —
-- no manual migration step needed.

CREATE TABLE IF NOT EXISTS signals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange        TEXT NOT NULL,
    pair            TEXT NOT NULL,
    timeframe       TEXT,
    direction       TEXT NOT NULL CHECK (direction IN ('BUY', 'SELL', 'NO_TRADE')),
    confidence      REAL NOT NULL,
    entry_zone_low  REAL,
    entry_zone_high REAL,
    stop_loss       REAL,
    take_profit     REAL,
    risk_reward     REAL,
    reasoning       TEXT,
    market_context  TEXT,
    status          TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'taken', 'ignored', 'expired')),
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_signals_pair_created ON signals (exchange, pair, created_at DESC);

-- Populated later once results are known (manually marked, or once auto-trading lands)
CREATE TABLE IF NOT EXISTS trade_outcomes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id       INTEGER REFERENCES signals(id),
    result          TEXT CHECK (result IN ('win', 'loss', 'breakeven', 'pending')),
    exit_price      REAL,
    pnl_pips        REAL,
    closed_at       TEXT,
    exit_reason     TEXT
);

CREATE TABLE IF NOT EXISTS bot_state (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
-- e.g. row: ('paused', '{"value": false}')

-- Real trades placed on MT5 via MetaApi, one row per position. Linked back
-- to the signal that suggested it so /stats can eventually cover live P&L.
CREATE TABLE IF NOT EXISTS mt5_trades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id       INTEGER REFERENCES signals(id),
    ticket          TEXT,
    mt5_symbol      TEXT NOT NULL,
    direction       TEXT NOT NULL CHECK (direction IN ('BUY', 'SELL')),
    lot_size        REAL NOT NULL,
    open_price      REAL,
    stop_loss       REAL,
    take_profit     REAL,
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'failed')),
    pnl             REAL,
    opened_by       TEXT,
    opened_at       TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_mt5_trades_status ON mt5_trades (status, opened_at DESC);
