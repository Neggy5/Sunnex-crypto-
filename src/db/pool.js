const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

// Local file DB via Node's built-in sqlite module — no external database
// service, no native compilation step (unlike better-sqlite3, which needs
// Python + build tools that Railway's build image doesn't have). On
// Railway, set DB_PATH to a path inside an attached Volume (e.g.
// /data/sunnex.db) so data survives redeploys; without a volume, Railway's
// filesystem is ephemeral and the file resets on every deploy/restart.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/sunnex.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

function init() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
}
init();

async function query(sql, params = []) {
  // Translate Postgres-style $1, $2... placeholders to SQLite's ? so callers
  // don't need to change.
  const sqliteSql = sql.replace(/\$(\d+)/g, '?');
  const stmt = db.prepare(sqliteSql);
  if (/^\s*select/i.test(sqliteSql)) {
    return { rows: stmt.all(...params) };
  }
  const info = stmt.run(...params);
  return { rows: [], lastInsertRowid: info.lastInsertRowid, changes: info.changes };
}

async function insertSignal(signal) {
  const {
    exchange, pair, timeframe, direction, confidence,
    entryZoneLow, entryZoneHigh, stopLoss, takeProfit,
    riskReward, reasoning, marketContext,
  } = signal;

  // node:sqlite (unlike better-sqlite3) throws on `undefined` bind params —
  // NO_TRADE results only set a few fields, so coerce everything to null.
  const n = (v) => (v === undefined ? null : v);

  const stmt = db.prepare(
    `INSERT INTO signals
      (exchange, pair, timeframe, direction, confidence, entry_zone_low, entry_zone_high,
       stop_loss, take_profit, risk_reward, reasoning, market_context)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const info = stmt.run(
    n(exchange), n(pair), n(timeframe), n(direction), n(confidence), n(entryZoneLow), n(entryZoneHigh),
    n(stopLoss), n(takeProfit), n(riskReward), n(reasoning),
    marketContext !== undefined ? JSON.stringify(marketContext) : null,
  );
  return info.lastInsertRowid;
}

async function getStats(sinceDays = 30) {
  const row = db.prepare(
    `SELECT
        COUNT(*) FILTER (WHERE s.direction != 'NO_TRADE') AS total_signals,
        COUNT(*) FILTER (WHERE o.result = 'win') AS wins,
        COUNT(*) FILTER (WHERE o.result = 'loss') AS losses,
        COALESCE(SUM(o.pnl_pips), 0) AS net_pips
     FROM signals s
     LEFT JOIN trade_outcomes o ON o.signal_id = s.id
     WHERE s.created_at > datetime('now', '-' || ? || ' days')`,
  ).get(sinceDays);
  return row;
}

async function setBotState(key, value) {
  db.prepare(
    `INSERT INTO bot_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, JSON.stringify(value));
}

async function getBotState(key, fallback = null) {
  const row = db.prepare('SELECT value FROM bot_state WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

async function insertMt5Trade(trade) {
  const {
    signalId, ticket, mt5Symbol, direction, lotSize,
    openPrice, stopLoss, takeProfit, openedBy,
  } = trade;
  const n = (v) => (v === undefined ? null : v);

  const stmt = db.prepare(
    `INSERT INTO mt5_trades
      (signal_id, ticket, mt5_symbol, direction, lot_size, open_price, stop_loss, take_profit, opened_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const info = stmt.run(
    n(signalId), n(ticket), mt5Symbol, direction, lotSize,
    n(openPrice), n(stopLoss), n(takeProfit), n(openedBy),
  );
  return info.lastInsertRowid;
}

async function closeMt5Trade(id, pnl) {
  db.prepare(
    `UPDATE mt5_trades SET status = 'closed', pnl = ?, closed_at = datetime('now') WHERE id = ?`,
  ).run(pnl, id);
}

async function failMt5Trade(id) {
  db.prepare(`UPDATE mt5_trades SET status = 'failed' WHERE id = ?`).run(id);
}

async function getOpenMt5Trades() {
  return db.prepare(`SELECT * FROM mt5_trades WHERE status = 'open' ORDER BY opened_at DESC`).all();
}

async function countOpenMt5Trades() {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM mt5_trades WHERE status = 'open'`).get();
  return row.n;
}

async function getTodayClosedPnl() {
  const row = db.prepare(
    `SELECT COALESCE(SUM(pnl), 0) AS total
     FROM mt5_trades
     WHERE status = 'closed' AND closed_at > datetime('now', 'start of day')`,
  ).get();
  return row.total;
}

module.exports = {
  db,
  query,
  insertSignal,
  getStats,
  setBotState,
  getBotState,
  insertMt5Trade,
  closeMt5Trade,
  failMt5Trade,
  getOpenMt5Trades,
  countOpenMt5Trades,
  getTodayClosedPnl,
};
