# Sunnex Crypto (Telegram Signal Bot)

Signal generation + Telegram alerts, with optional real order execution on
MT5 via MetaApi.cloud. Live trading is off by default and gated behind an
explicit `/enabletrading` admin command every deploy — see below.

## Architecture

```
Binance / Bybit public REST APIs (via ccxt)
      │
      ▼
This bot (Railway, Node.js)
   ├── exchange client (src/services/exchange.js) — unified multi-exchange interface
   ├── analysis engine (trend/S&R/breakout)
   ├── signal scoring
   ├── SQLite via Node's built-in `node:sqlite` (signals + journal, local
   │   file — no external DB service, no native build step)
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

The database is a local SQLite file via Node's built-in `node:sqlite` module
(no `better-sqlite3`, so no native compilation at build time — this avoids
Railway build failures from missing Python/build tools). The schema
(`src/db/schema.sql`) is applied automatically on startup — no manual
migration step, no external DB service to provision. Requires Node ≥22.5.

## Telegram commands

- `/status` — bot + per-exchange connection status
- `/price [pair]` — live bid/ask (all configured pairs, or one)
- `/stats [days]` — win rate, net pips over the period (default 30 days)
- `/pause` / `/resume` — admin-only, stop/start signal scanning
- `/mt5status` — admin-only, MT5 connection + balance + trading gate state
- `/positions` — admin-only, list open MT5 trades with a Close button
- `/enabletrading` / `/disabletrading` — admin-only, the live-trading gate
- Real signals get a **📈 Place Trade (MT5)** button (admin-only, only shown
  if MT5 is configured and the pair has a symbol mapping)

## Config (.env)

- `EXCHANGES` — comma-separated ccxt exchange ids to scan (e.g. `binance,bybit`)
- `PAIRS` — comma-separated symbols in ccxt format, e.g. `BTC/USDT`
- `TIMEFRAMES` — comma-separated ccxt timeframe strings (`15m`, `1h`, `4h`, ...); first one is the "entry" timeframe (weighted higher)
- `MIN_SIGNAL_SCORE` — confluence score threshold (0-100) to fire a signal
- `MIN_RR` — minimum risk/reward to fire a signal
- `SPREAD_LIMIT_PIPS` — skip evaluation if spread exceeds this

## MT5 live trading (optional)

Real order placement via [MetaApi.cloud](https://metaapi.cloud), a hosted
bridge to your actual MT5 account — this bot runs on Railway (Linux), and
MT5 itself has no public REST API, so a bridge is required either way.

**Setup:**
1. Create a MetaApi.cloud account and add your MT5 account (demo first —
   strongly recommended) through their dashboard to get an `accountId`.
2. Generate an API token in the MetaApi dashboard.
3. Set `METAAPI_TOKEN` and `METAAPI_ACCOUNT_ID` in your env vars.
4. Set `MT5_SYMBOL_MAP` to match your broker's exact symbol names (check
   MT5's Market Watch — naming varies a lot between brokers, e.g. `BTCUSD`
   vs `BTCUSDm` vs `BTCUSD.a`). A pair with no mapping simply won't show a
   Place Trade button.
5. Set `MT5_LOT_SIZE`, `MT5_MAX_OPEN_POSITIONS`, `MT5_MAX_DAILY_LOSS` to
   your risk tolerance.
6. Deploy, then send **`/enabletrading`** in Telegram. This step is
   required every time — the gate defaults to disabled on every fresh
   deploy, on purpose, regardless of whether MetaApi is configured.

**Why signal prices and MT5 order prices differ:** signals are computed from
Binance/Bybit spot prices, but your MT5 broker quotes its own CFD price for
the same asset — the two feeds are not identical. Rather than sending the
Binance-computed price as an absolute stop-loss/take-profit (which could
land in the wrong place on a different price feed), the bot takes the
*distance* implied by the signal's risk:reward and re-applies it to the
live MT5 price at the moment the order is placed. This preserves the
intended risk shape even though execution happens on a different venue.

**Safety gates enforced before every order:**
- `/enabletrading` must have been explicitly sent this deploy
- Max concurrent open positions (`MT5_MAX_OPEN_POSITIONS`)
- Daily closed-P&L floor (`MT5_MAX_DAILY_LOSS`) — no new trades once hit
- Pair must have an `MT5_SYMBOL_MAP` entry

**This code has not been tested against a live MetaApi account** (no
network access in the environment that built it) — the MetaApi SDK calls
follow their documented API surface, but SDK versions do drift. Test
thoroughly on a demo account, starting with the smallest possible lot size,
before ever pointing `METAAPI_ACCOUNT_ID` at a live account.

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
