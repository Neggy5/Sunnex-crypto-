# Sunnex Crypto (Telegram Signal Bot)

Phase 1: signal generation + Telegram alerts only. No live order execution —
that's a deliberate later phase once signal quality is proven via `/stats`
and backtesting.

## Architecture

```
Binance / Bybit public REST APIs (via ccxt)
      │
      ▼
This bot (Railway, Node.js)
   ├── exchange client (src/services/exchange.js) — unified multi-exchange interface
   ├── analysis engine (trend/S&R/breakout)
   ├── signal scoring
   ├── SQLite (signals + journal, local file — no external DB service)
   └── Telegraf → Telegram channel/group
```

Unlike MT5, Binance and Bybit expose their market data over public REST/WebSocket
APIs directly — no separate bridge service or Windows host required. Market
data (prices, candles) needs no API key at all; keys are only required once
you add order placement in a later phase.

`src/services/exchange.js` wraps both exchanges through
[ccxt](https://github.com/ccxt/ccxt), so the rest of the app (`signalEngine.js`,
`analysis.js`) is exchange-agnostic — add a third exchange by adding its name
to `EXCHANGES` in `.env`, no code changes needed as long as ccxt supports it.

## Setup

1. `cp .env.example .env` and fill in values (API keys optional for phase 1).
2. `npm install`
3. `npm run dev` locally, or push to Railway.

The database is a local SQLite file. The schema (`src/db/schema.sql`) is
applied automatically on startup — no manual migration step, no external DB
service to provision.

## Telegram commands

- `/status` — bot + per-exchange connection status
- `/stats [days]` — win rate, net pips over the period (default 30 days)
- `/pause` / `/resume` — admin-only, stop/start signal scanning

## Config (.env)

- `EXCHANGES` — comma-separated ccxt exchange ids to scan (e.g. `binance,bybit`)
- `PAIRS` — comma-separated symbols in ccxt format, e.g. `BTC/USDT`
- `TIMEFRAMES` — comma-separated ccxt timeframe strings (`15m`, `1h`, `4h`, ...); first one is the "entry" timeframe (weighted higher)
- `MIN_SIGNAL_SCORE` — confluence score threshold (0-100) to fire a signal
- `MIN_RR` — minimum risk/reward to fire a signal
- `SPREAD_LIMIT_PIPS` — skip evaluation if spread exceeds this

## Deploying to Railway

1. Push this repo to GitHub.
2. New Railway project → Deploy from GitHub repo.
3. Set env vars from `.env.example` in Railway's dashboard — at minimum
   `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
4. **Attach a Volume** (Railway project → Settings → Volumes) and mount it
   at, say, `/data`. Set `DB_PATH=/data/sunnex.db` in your env vars.
   Without this, Railway's filesystem is ephemeral and signal history /
   pause state resets on every redeploy.
5. Railway reads `railway.json` for the start command and health check
   (`GET /health` on `$PORT`, auto-restart on failure). `Procfile` is kept
   as a fallback for other platforms.

No database plugin, connection string, or manual schema step needed — the
SQLite file is created and migrated automatically on first boot.

## Next phases (not built yet)

- Backtesting runner against historical exchange candles (`npm run backtest` stub)
- Auto-trading + risk engine (max daily loss, max drawdown, position sizing) using exchange order endpoints
- Trade outcome tracking to auto-populate `trade_outcomes` from exchange fills
