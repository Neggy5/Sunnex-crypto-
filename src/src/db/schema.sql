-- SQLite schema. Applied automatically on startup by src/db/pool.js —
-- no manual migration step needed.

CREATE TABLE IF NOT EXISTS signals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange        TEXT NOT NULL,
    pair            TEXT NOT NULL,
    timeframe       TEXT NOT NULL,
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
