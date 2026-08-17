const { Telegraf, Markup } = require('telegraf');
const {
  formatSignal, formatStats, formatLeaderboard, formatDigest, formatScanBlock,
} = require('./format');
const db = require('../db/pool');
const exchange = require('../services/exchange');
const mt5 = require('../services/mt5');
const signalEngine = require('../engine/signalEngine');
const { runBacktest } = require('../backtest/engine');
const logger = require('../utils/logger');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ADMIN_IDS = (process.env.TELEGRAM_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const EXCHANGES = (process.env.EXCHANGES || 'binance,bybit').split(',').map((s) => s.trim());
const PAIRS = (process.env.PAIRS || 'BTC/USDT,ETH/USDT,BNB/USDT,SOL/USDT,XRP/USDT,DOGE/USDT,ADA/USDT,AVAX/USDT,LINK/USDT,LTC/USDT,DOT/USDT').split(',').map((s) => s.trim());
const TIMEFRAMES = (process.env.TIMEFRAMES || '15m,1h').split(',').map((s) => s.trim());

// MT5 live-trading config — all guarded by an explicit /enabletrading gate
// (bot_state.trading_enabled) that defaults OFF, independent of whether
// MetaApi credentials are even configured. Nothing places a real order
// until an admin turns this on explicitly, every single deploy.
const MT5_LOT_SIZE = Number(process.env.MT5_LOT_SIZE || 0.01);
const MT5_MAX_OPEN_POSITIONS = Number(process.env.MT5_MAX_OPEN_POSITIONS || 3);
const MT5_MAX_DAILY_LOSS = Number(process.env.MT5_MAX_DAILY_LOSS || -50); // account currency, negative

// Used by the position-size calculator when MT5 isn't configured (or its
// balance call fails) — a fallback account size so the button still works.
const RISK_FALLBACK_BALANCE = Number(process.env.RISK_FALLBACK_BALANCE || 1000);
const RISK_PERCENT_PER_TRADE = Number(process.env.RISK_PERCENT_PER_TRADE || 1); // % of balance

function isAdmin(ctx) {
  return ADMIN_IDS.includes(String(ctx.from.id));
}

// Watchlist is a dynamic override of the env PAIRS list, stored in bot_state
// so it survives restarts without needing a redeploy. Falls back to PAIRS
// when nothing's been set yet.
async function getWatchlist() {
  const state = await db.getBotState('watchlist', null);
  return state && Array.isArray(state.pairs) && state.pairs.length ? state.pairs : PAIRS;
}

async function setWatchlist(pairs) {
  await db.setBotState('watchlist', { pairs });
}

function timeAgo(isoString) {
  const seconds = Math.round((Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

// Telegram only shows a command list in the UI (the "/" menu, and the
// hamburger next to the message box) if you register it explicitly — having
// bot.command() handlers alone doesn't do that. This runs once at launch.
const COMMAND_LIST = [
  { command: 'start', description: 'Show what this bot does' },
  { command: 'menu', description: 'Show this command list' },
  { command: 'status', description: 'Bot + exchange connection status' },
  { command: 'price', description: 'Live prices (all pairs, or e.g. /price BTC/USDT)' },
  { command: 'stats', description: 'Win rate and net pips (optionally: /stats 7)' },
  { command: 'leaderboard', description: 'Top pairs by net pips (optionally: /leaderboard 7)' },
  { command: 'watchlist', description: 'Show pairs currently being scanned' },
  { command: 'addpair', description: 'Add a pair to the watchlist, e.g. /addpair SOL/USDT (admin)' },
  { command: 'removepair', description: 'Remove a pair from the watchlist (admin)' },
  { command: 'chart', description: 'TradingView chart link, e.g. /chart BTC/USDT' },
  { command: 'scan', description: 'Run an immediate scan — full detail; add "brief" for a compact one-liner (admin)' },
  {
    command: 'backtest', description: 'Walk historical candles through the engine to see example >=score BUY/SELL signals — no trade placed (admin). Usage: /backtest [PAIR] [MINSCORE]',
  },
  { command: 'pause', description: 'Stop signal scanning (admin)' },
  { command: 'resume', description: 'Resume signal scanning (admin)' },
  { command: 'mt5status', description: 'MT5 connection + account balance (admin)' },
  { command: 'positions', description: 'List open MT5 trades (admin)' },
  { command: 'enabletrading', description: 'Allow real MT5 order placement (admin)' },
  { command: 'disabletrading', description: 'Block real MT5 order placement (admin)' },
];

async function registerCommands() {
  await bot.telegram.setMyCommands(COMMAND_LIST);
  logger.info('Command menu registered with Telegram');
}

// Button color helper — Bot API 9.4 (Feb 9, 2026) added `style` to
// InlineKeyboardButton: "primary" (blue), "success" (green), "danger" (red).
// Omit the field entirely for the default blue rather than passing "primary".
function styledButton(text, callbackData, style) {
  const button = Markup.button.callback(text, callbackData);
  return style ? { ...button, style } : button;
}

bot.command('start', (ctx) => {
  ctx.reply(
    '⚡ Sunnex Crypto — scans configured pairs for confluence-based BUY/SELL setups '
    + 'and posts them here. Real MT5 order placement is available (admin) but stays '
    + 'off until /enabletrading is sent.\n\n'
    + 'Use the menu button (☰) or type a command below.',
    Markup.inlineKeyboard([
      [
        styledButton('📊 Status', 'menu:status'),
        styledButton('💹 Live Prices', 'menu:prices', 'success'),
      ],
      [
        styledButton('📈 Performance', 'menu:stats'),
        styledButton('⭐ Watchlist', 'menu:watchlist', 'success'),
      ],
      [
        styledButton('❓ Commands', 'menu:help'),
        styledButton('⚠️ Risk Disclaimer', 'menu:disclaimer', 'danger'),
      ],
    ]),
  );
});

bot.command('menu', (ctx) => {
  const lines = COMMAND_LIST.map((c) => `/${c.command} — ${c.description}`);
  ctx.reply(`Available commands:\n\n${lines.join('\n')}`);
});

bot.command('status', async (ctx) => {
  const paused = await db.getBotState('paused', { value: false });
  const lastScan = await db.getBotState('last_scan', null);
  const connections = await Promise.all(
    EXCHANGES.map(async (name) => `${name}: ${(await exchange.isConnected(name)) ? '🟢' : '🔴'}`),
  );
  const lastScanLine = lastScan
    ? `Last scan: ${timeAgo(lastScan.at)} — ${lastScan.pairsScanned} pair(s) checked, ${lastScan.signalsFired} signal(s) fired`
    : 'Last scan: none yet';
  await ctx.reply(
    `Bot status: ${paused.value ? '⏸ paused' : '▶️ running'}\n${connections.join('\n')}\n${lastScanLine}`,
    Markup.inlineKeyboard([
      paused.value
        ? styledButton('▶️ Resume', 'admin:resume', 'success')
        : styledButton('⏸ Pause', 'admin:pause', 'danger'),
      styledButton('🔄 Refresh', 'status:refresh'),
    ]),
  );
});

// Fetches one pair's price from every source that has it configured/mapped:
// crypto exchanges (Binance/Bybit) plus, if MT5_SYMBOL_MAP has an entry for
// this pair, the live MT5 broker feed too. This is what lets forex pairs
// like EUR/USD — which no crypto exchange lists — actually resolve to a
// real price instead of always showing "unavailable".
async function fetchPairPriceRows(pair) {
  const rows = [];
  for (const exchangeName of EXCHANGES) {
    try {
      const { bid, ask } = await exchange.getPrice(exchangeName, pair);
      const mid = (bid + ask) / 2;
      rows.push(`${exchangeName}: ${pair} — ${mid.toFixed(mid < 10 ? 5 : 2)} (bid ${bid} / ask ${ask})`);
    } catch (err) {
      rows.push(`${exchangeName}: ${pair} — unavailable (${err.message})`);
    }
  }

  const mt5Symbol = mt5.mapSymbol(pair);
  if (mt5.isConfigured() && mt5Symbol) {
    try {
      const { bid, ask } = await mt5.getMt5Price(mt5Symbol);
      const mid = (bid + ask) / 2;
      rows.push(`mt5 (${mt5Symbol}): ${pair} — ${mid.toFixed(mid < 10 ? 5 : 2)} (bid ${bid} / ask ${ask})`);
    } catch (err) {
      rows.push(`mt5 (${mt5Symbol}): ${pair} — unavailable (${err.message})`);
    }
  }

  return rows;
}

bot.command('price', async (ctx) => {
  const arg = ctx.message.text.split(' ')[1]?.toUpperCase();
  const requestedPair = arg ? (arg.includes('/') ? arg : `${arg}/USDT`) : null;
  const pairsToFetch = requestedPair ? [requestedPair] : await getWatchlist();

  const rows = [];
  for (const pair of pairsToFetch) {
    rows.push(...await fetchPairPriceRows(pair));
  }

  if (!rows.length) return ctx.reply(`No price data for ${requestedPair || 'configured pairs'}.`);
  await ctx.reply(`💹 Live prices\n\n${rows.join('\n')}`);
});

bot.command('stats', async (ctx) => {
  const days = Number(ctx.message.text.split(' ')[1]) || 30;
  const stats = await db.getStats(days);
  ctx.reply(formatStats(stats, days));
});

// Compact one-liner — the original /scan output, kept for `/scan brief`
// when the full breakdown per pair is more than you want scrolling through.
function formatScanBriefLine(signal) {
  if (signal.direction === 'NO_TRADE') {
    return `⚪ ${signal.exchange}:${signal.pair} — no trade (score ${signal.confidence}/${signal.minSignalScore ?? '?'}) — ${signal.reasoning}`;
  }
  return `${signal.direction === 'BUY' ? '🟢' : '🔴'} ${signal.exchange}:${signal.pair} — ${signal.direction} @ ${signal.confidence}% confidence`;
}

// Packs blocks into <=maxChunk-sized messages without ever splitting a
// single block across two messages (a "block" here is one full signal's
// worth of detail — BUY/SELL, confidence, entry/SL/TP/R:R, reasoning — so
// it always stays together as one readable unit). Two-pass: pack first,
// then label with "Part i/N" once the total is known, so headers only
// appear when there's actually more than one message.
function packIntoChunks(header, blocks, maxChunk = 3500) {
  const separator = '\n\n───────────\n\n';
  const chunks = [];
  let current = '';

  for (const block of blocks) {
    if (current && current.length + separator.length + block.length > maxChunk) {
      chunks.push(current);
      current = '';
    }
    if (block.length > maxChunk) {
      // a single block is itself too big (shouldn't normally happen) —
      // send it alone rather than corrupting the pack-together guarantee
      if (current) { chunks.push(current); current = ''; }
      chunks.push(block);
      continue;
    }
    current += (current ? separator : '') + block;
  }
  if (current) chunks.push(current);

  const total = chunks.length;
  return chunks.map((body, i) => {
    const partLabel = total > 1 ? `Part ${i + 1}/${total}\n\n` : '';
    const headerLine = i === 0 ? `${header}\n\n` : '';
    return `${partLabel}${headerLine}${body}`;
  });
}

bot.command('scan', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  const brief = ctx.message.text.split(' ')[1]?.toLowerCase() === 'brief';
  const pairs = await getWatchlist();
  await ctx.reply(`🔎 Scanning ${EXCHANGES.length * pairs.length} exchange/pair combo(s) live — this hits Binance/Bybit for real, may take a few seconds…`);

  const blocks = [];
  let signalsFired = 0;
  for (const exchangeName of EXCHANGES) {
    for (const pair of pairs) {
      try {
        const signal = await signalEngine.evaluatePair(exchangeName, pair, TIMEFRAMES);
        if (signal.direction === 'NO_TRADE') {
          await db.insertSignal(signal);
        } else {
          signalsFired += 1;
          await pushSignal(signal); // inserts + posts to chat
        }
        blocks.push(brief ? formatScanBriefLine(signal) : formatScanBlock(signal));
      } catch (err) {
        blocks.push(`🔴 ${exchangeName}:${pair} — error: ${err.message}`);
      }
    }
  }

  await recordScan(pairs.length * EXCHANGES.length, signalsFired);

  const header = `Scan complete — ${signalsFired} signal(s) fired out of ${blocks.length} evaluated:`;
  const messages = packIntoChunks(header, blocks, brief ? 3800 : 3500);
  for (const msg of messages) {
    // eslint-disable-next-line no-await-in-loop
    await ctx.reply(msg);
  }
});

// Historical-candle backtest, runnable straight from the chat — no order
// placed, no live signal posted, no DB write. Scoped to one pair per run
// (defaults to the first watchlist pair) and a smaller candle count than
// `npm run backtest`'s default, since this runs synchronously inside a
// Telegram command and an admin is waiting on the reply.
const BACKTEST_TELEGRAM_CANDLES = Number(process.env.BACKTEST_TELEGRAM_CANDLES || 500);
const BACKTEST_TELEGRAM_WINDOW = Number(process.env.BACKTEST_WINDOW || 200);
// Same assumed-spread stand-in as the CLI backtest (npm run backtest) — see
// engine.js backtestPair() for why. Shared env var so both entry points
// stay configured identically.
const BACKTEST_ASSUMED_SPREAD_PIPS = Number(process.env.BACKTEST_ASSUMED_SPREAD_PIPS || 0);
// Same fee/slippage assumptions as the CLI backtest — see run.js for
// rationale. Shared env vars so both entry points stay configured identically.
const BACKTEST_FEE_PCT_PER_SIDE = Number(process.env.BACKTEST_FEE_PCT_PER_SIDE ?? 0.1);
const BACKTEST_SLIPPAGE_PCT_PER_SIDE = Number(process.env.BACKTEST_SLIPPAGE_PCT_PER_SIDE ?? 0.05);
let backtestRunning = false;

bot.command('backtest', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  if (backtestRunning) return ctx.reply('A backtest is already running — wait for it to finish before starting another.');

  const args = ctx.message.text.split(' ').slice(1);
  const pairArg = args[0]?.toUpperCase();
  const pair = pairArg ? (pairArg.includes('/') ? pairArg : `${pairArg}/USDT`) : (await getWatchlist())[0];
  const minScore = Number(args[1]) || 70;

  if (!pair) return ctx.reply('No pair to backtest — watchlist is empty and none was given. Usage: /backtest [PAIR] [MINSCORE]');

  backtestRunning = true;
  await ctx.reply(
    `📜 Backtesting ${pair} on ${EXCHANGES.join(', ')} — ${BACKTEST_TELEGRAM_CANDLES} historical candles/timeframe `
    + `across ${TIMEFRAMES.join(', ')}, looking for >=${minScore} confidence. This hits the exchange for real `
    + 'historical data (read-only) and can take 10-30s…',
  );

  try {
    const { summary } = await runBacktest({
      exchanges: EXCHANGES,
      pairs: [pair],
      timeframes: TIMEFRAMES,
      historyCandles: BACKTEST_TELEGRAM_CANDLES,
      window: BACKTEST_TELEGRAM_WINDOW,
      reportMinScore: minScore,
      assumedSpreadPips: BACKTEST_ASSUMED_SPREAD_PIPS,
      feePctPerSide: BACKTEST_FEE_PCT_PER_SIDE,
      slippagePctPerSide: BACKTEST_SLIPPAGE_PCT_PER_SIDE,
    });

    const headerLine = `Backtest complete — ${pair}: ${summary.totalSignals} signal(s) fired `
      + `(BUY ${summary.buyCount} / SELL ${summary.sellCount}) across the walk-forward run. `
      + `Qualifying at >=${minScore}: BUY ${summary.qualifyingBuy.length} / SELL ${summary.qualifyingSell.length}.`;

    if (!summary.qualifyingBuy.length && !summary.qualifyingSell.length) {
      await ctx.reply(
        `${headerLine}\n\nNo example cleared >=${minScore} in this window — often a legitimate result (conflicting `
        + 'timeframes cap the score), not a bug. Try a different pair, a lower MINSCORE, or `npm run backtest` '
        + 'locally with more history.',
      );
      return;
    }

    // s.trades is every qualifying signal (not just the 2+2 examples below),
    // each walked forward through the historical candles after it fired to
    // see whether takeProfit or stopLoss was hit first. P/L is in
    // R-multiples (asset-agnostic — works the same for crypto as forex).
    const s = summary.statsQualifying;
    const statsBlock = [
      '📊 Performance (qualifying signals):',
      `Trades: ${s.totalTrades} closed, ${s.openTrades} still open at end of history`,
      `Wins/Losses: ${s.wins}/${s.losses}  |  Win rate: ${s.winRate === null ? 'n/a' : `${s.winRate.toFixed(1)}%`}`,
      `Total P/L: ${s.totalPL === null ? 'n/a' : `${s.totalPL >= 0 ? '+' : ''}${s.totalPL.toFixed(2)}R`}`,
      `Avg R:R (planned): ${s.avgRR === null ? 'n/a' : s.avgRR.toFixed(2)}  |  Max drawdown: ${s.maxDrawdown.toFixed(2)}R`,
    ].join('\n');

    const outcomesBlock = [
      '📋 Individual signal outcomes:',
      ...s.trades.map((t) => {
        const tag = t.outcome === 'TP' ? '✅ TP hit' : (t.outcome === 'SL' ? '❌ SL hit' : '⏳ still open');
        const pnl = t.pnlR === null ? '' : ` (${t.pnlR >= 0 ? '+' : ''}${t.pnlR.toFixed(2)}R)`;
        const ambiguous = t.outcomeAmbiguous ? ' [SL/TP same candle, assumed SL]' : '';
        const when = t.backtestTime.slice(0, 16).replace('T', ' ');
        return `${when} ${t.direction} ${t.exchange} conf ${t.confidence}% → ${tag}${pnl}, ${t.barsHeld} bars${ambiguous}`;
      }),
    ].join('\n');

    const blocks = [statsBlock, outcomesBlock];
    summary.qualifyingBuy.slice(0, 2).forEach((sig) => blocks.push(`[as of ${sig.backtestTime}]\n${formatScanBlock(sig)}`));
    summary.qualifyingSell.slice(0, 2).forEach((sig) => blocks.push(`[as of ${sig.backtestTime}]\n${formatScanBlock(sig)}`));

    const messages = packIntoChunks(headerLine, blocks, 3500);
    for (const msg of messages) {
      // eslint-disable-next-line no-await-in-loop
      await ctx.reply(msg);
    }
  } catch (err) {
    logger.error(`Telegram /backtest failed: ${err.message}`);
    await ctx.reply(`⚠️ Backtest failed: ${err.message}`);
  } finally {
    backtestRunning = false;
  }
});

bot.command('mt5status', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  if (!mt5.isConfigured()) return ctx.reply('MT5 not configured — set METAAPI_TOKEN and METAAPI_ACCOUNT_ID.');

  const tradingOn = await isTradingEnabled();
  try {
    const info = await mt5.getAccountInfo();
    const openCount = await db.countOpenMt5Trades();
    const todayPnl = await db.getTodayClosedPnl();
    await ctx.reply(
      `MT5 account: ${info.name || info.login}\n`
      + `Trading: ${tradingOn ? '🟢 enabled' : '🔴 disabled'}\n`
      + `Balance: ${info.balance} ${info.currency}\n`
      + `Equity: ${info.equity} ${info.currency}\n`
      + `Open positions (tracked): ${openCount}/${MT5_MAX_OPEN_POSITIONS}\n`
      + `Today's closed P&L: ${todayPnl.toFixed(2)} ${info.currency} (cap ${MT5_MAX_DAILY_LOSS})`,
    );
  } catch (err) {
    await ctx.reply(`⚠️ MT5 connection error: ${err.message}`);
  }
});

bot.command('positions', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  const trades = await db.getOpenMt5Trades();
  if (!trades.length) return ctx.reply('No open MT5 positions tracked.');

  for (const t of trades) {
    await ctx.reply(
      `${t.direction} ${t.lot_size} ${t.mt5_symbol}\n`
      + `Opened: ${t.open_price ?? 'n/a'} | SL: ${t.stop_loss ?? 'n/a'} | TP: ${t.take_profit ?? 'n/a'}\n`
      + `Ticket: ${t.ticket}`,
      Markup.inlineKeyboard([styledButton('❌ Close Position', `mt5:close:${t.id}`, 'danger')]),
    );
  }
});

bot.command('enabletrading', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  if (!mt5.isConfigured()) return ctx.reply('MT5 not configured — set METAAPI_TOKEN and METAAPI_ACCOUNT_ID first.');
  await db.setBotState('trading_enabled', { value: true });
  await ctx.reply('🟢 Real MT5 order placement ENABLED. "Place Trade" buttons on signals will now execute real orders.');
});

bot.command('disabletrading', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  await db.setBotState('trading_enabled', { value: false });
  await ctx.reply('🔴 Real MT5 order placement DISABLED.');
});

bot.command('pause', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  await db.setBotState('paused', { value: true });
  ctx.reply('⏸ Signal scanning paused.');
});

bot.command('resume', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  await db.setBotState('paused', { value: false });
  ctx.reply('▶️ Signal scanning resumed.');
});

// Handles the buttons attached to /status
bot.action('admin:pause', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Not authorized.');
  await db.setBotState('paused', { value: true });
  await ctx.answerCbQuery('Paused');
  await ctx.editMessageText(
    'Bot status: ⏸ paused',
    Markup.inlineKeyboard([styledButton('▶️ Resume', 'admin:resume', 'success')]),
  );
});

bot.action('admin:resume', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Not authorized.');
  await db.setBotState('paused', { value: false });
  await ctx.answerCbQuery('Resumed');
  await ctx.editMessageText(
    'Bot status: ▶️ running',
    Markup.inlineKeyboard([styledButton('⏸ Pause', 'admin:pause', 'danger')]),
  );
});

bot.action('status:refresh', async (ctx) => {
  const paused = await db.getBotState('paused', { value: false });
  const connections = await Promise.all(
    EXCHANGES.map(async (name) => `${name}: ${(await exchange.isConnected(name)) ? '🟢' : '🔴'}`),
  );
  await ctx.answerCbQuery('Refreshed');
  await ctx.editMessageText(
    `Bot status: ${paused.value ? '⏸ paused' : '▶️ running'}\n${connections.join('\n')}`,
    Markup.inlineKeyboard([
      paused.value
        ? styledButton('▶️ Resume', 'admin:resume', 'success')
        : styledButton('⏸ Pause', 'admin:pause', 'danger'),
      styledButton('🔄 Refresh', 'status:refresh'),
    ]),
  );
});

// Lets you mark a signal's real-world outcome directly from the message —
// feeds trade_outcomes so /stats becomes meaningful before auto-trading exists.
bot.action(/^signal:(\d+):(taken|ignored)$/, async (ctx) => {
  const [, signalId, action] = ctx.match;
  await db.query('UPDATE signals SET status = $1 WHERE id = $2', [action, signalId]);
  await ctx.answerCbQuery(action === 'taken' ? 'Marked as taken' : 'Marked as ignored');
  await ctx.editMessageReplyMarkup(
    Markup.inlineKeyboard([
      styledButton(action === 'taken' ? '✅ Taken' : '❌ Ignored', 'noop'),
    ]).reply_markup,
  );
});

bot.action('noop', (ctx) => ctx.answerCbQuery());

// Handlers for the coloured quick-action buttons on /start. Each just
// answers the callback and sends the same info the matching /command would.
bot.action('menu:status', async (ctx) => {
  await ctx.answerCbQuery();
  const paused = await db.getBotState('paused', { value: false });
  const lastScan = await db.getBotState('last_scan', null);
  const connections = await Promise.all(
    EXCHANGES.map(async (name) => `${name}: ${(await exchange.isConnected(name)) ? '🟢' : '🔴'}`),
  );
  const lastScanLine = lastScan
    ? `Last scan: ${timeAgo(lastScan.at)} — ${lastScan.pairsScanned} pair(s) checked, ${lastScan.signalsFired} signal(s) fired`
    : 'Last scan: none yet';
  await ctx.reply(
    `Bot status: ${paused.value ? '⏸ paused' : '▶️ running'}\n${connections.join('\n')}\n${lastScanLine}`,
    Markup.inlineKeyboard([
      paused.value
        ? styledButton('▶️ Resume', 'admin:resume', 'success')
        : styledButton('⏸ Pause', 'admin:pause', 'danger'),
      styledButton('🔄 Refresh', 'status:refresh'),
    ]),
  );
});

bot.action('menu:prices', async (ctx) => {
  await ctx.answerCbQuery();
  const pairsToFetch = await getWatchlist();
  const rows = [];
  for (const pair of pairsToFetch) {
    rows.push(...await fetchPairPriceRows(pair));
  }
  await ctx.reply(rows.length ? `💹 Live prices\n\n${rows.join('\n')}` : 'No price data available.');
});

bot.action('menu:stats', async (ctx) => {
  await ctx.answerCbQuery();
  const stats = await db.getStats(30);
  await ctx.reply(formatStats(stats, 30));
});

bot.action('menu:watchlist', async (ctx) => {
  await ctx.answerCbQuery();
  const pairs = await getWatchlist();
  await ctx.reply(
    `⭐ Watchlist (${pairs.length} pair${pairs.length === 1 ? '' : 's'})\n\n${pairs.join('\n')}\n\n`
    + 'Add: /addpair SOL/USDT · Remove: /removepair SOL/USDT (admin)',
  );
});

bot.action('menu:help', async (ctx) => {
  await ctx.answerCbQuery();
  const lines = COMMAND_LIST.map((c) => `/${c.command} — ${c.description}`);
  await ctx.reply(`Available commands:\n\n${lines.join('\n')}`);
});

bot.action('menu:disclaimer', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    '⚠️ Risk Disclaimer\n\n'
    + 'Signals are automated technical analysis, not financial advice. Crypto '
    + 'markets are volatile — past signal performance does not guarantee future '
    + 'results. Only trade with funds you can afford to lose, and size positions '
    + 'according to your own risk tolerance.',
  );
});

// Dynamic watchlist management — lets an admin change which pairs are
// scanned without a redeploy. Falls back to the PAIRS env var until set.
bot.command('watchlist', async (ctx) => {
  const pairs = await getWatchlist();
  await ctx.reply(
    `⭐ Watchlist (${pairs.length} pair${pairs.length === 1 ? '' : 's'})\n\n${pairs.join('\n')}\n\n`
    + 'Add: /addpair SOL/USDT · Remove: /removepair SOL/USDT (admin)',
  );
});

bot.command('addpair', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  const arg = ctx.message.text.split(' ')[1]?.toUpperCase();
  if (!arg) return ctx.reply('Usage: /addpair BTC/USDT');
  const pair = arg.includes('/') ? arg : `${arg}/USDT`;

  const pairs = await getWatchlist();
  if (pairs.includes(pair)) return ctx.reply(`${pair} is already on the watchlist.`);

  await setWatchlist([...pairs, pair]);
  await ctx.reply(`✅ Added ${pair} to the watchlist. It'll be included from the next scan onward.`);
});

bot.command('removepair', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  const arg = ctx.message.text.split(' ')[1]?.toUpperCase();
  if (!arg) return ctx.reply('Usage: /removepair BTC/USDT');
  const pair = arg.includes('/') ? arg : `${arg}/USDT`;

  const pairs = await getWatchlist();
  if (!pairs.includes(pair)) return ctx.reply(`${pair} isn't on the watchlist.`);

  const updated = pairs.filter((p) => p !== pair);
  if (!updated.length) return ctx.reply('Refusing to remove the last pair — watchlist can\'t be empty.');

  await setWatchlist(updated);
  await ctx.reply(`✅ Removed ${pair} from the watchlist.`);
});

// TradingView chart link — a URL button, so it opens outside Telegram
// rather than round-tripping through a callback.
bot.command('chart', async (ctx) => {
  const arg = ctx.message.text.split(' ')[1]?.toUpperCase();
  if (!arg) return ctx.reply('Usage: /chart BTC/USDT');
  const pair = arg.includes('/') ? arg : `${arg}/USDT`;
  const symbol = pair.replace('/', '');

  await ctx.reply(
    `📊 ${pair} chart`,
    Markup.inlineKeyboard([
      Markup.button.url('Open in TradingView', `https://www.tradingview.com/chart/?symbol=${symbol}`),
    ]),
  );
});

// Per-pair performance ranking, reusing the same signals/trade_outcomes
// data as /stats but grouped by pair.
bot.command('leaderboard', async (ctx) => {
  const days = Number(ctx.message.text.split(' ')[1]) || 30;
  const rows = await db.getPairLeaderboard(days);
  await ctx.reply(formatLeaderboard(rows, days));
});

// Position-size calculator, attached to every signal alongside the
// existing Mark Taken / Ignore / Place Trade buttons. Pure arithmetic —
// no order is placed. Uses live MT5 balance when available, else falls
// back to RISK_FALLBACK_BALANCE, and risks RISK_PERCENT_PER_TRADE % of it.
bot.action(/^calc:(\d+)$/, async (ctx) => {
  const [, signalId] = ctx.match;
  const { rows } = await db.query('SELECT * FROM signals WHERE id = $1', [signalId]);
  const row = rows[0];
  if (!row || row.direction === 'NO_TRADE') {
    return ctx.answerCbQuery('Signal not found.', { show_alert: true });
  }

  let balance = RISK_FALLBACK_BALANCE;
  let currency = 'USD';
  let source = 'fallback balance';
  if (mt5.isConfigured()) {
    try {
      const info = await mt5.getAccountInfo();
      balance = info.balance;
      currency = info.currency;
      source = 'MT5 account balance';
    } catch {
      // stick with the fallback if MT5 is unreachable right now
    }
  }

  const entry = (row.entry_zone_low + row.entry_zone_high) / 2;
  const stopDistance = Math.abs(entry - row.stop_loss);
  const riskAmount = balance * (RISK_PERCENT_PER_TRADE / 100);
  const units = stopDistance > 0 ? riskAmount / stopDistance : 0;

  await ctx.answerCbQuery(
    `Risking ${RISK_PERCENT_PER_TRADE}% of ${balance.toFixed(2)} ${currency} (${source}) = `
    + `${riskAmount.toFixed(2)} ${currency}\n`
    + `Stop distance: ${stopDistance.toFixed(5)} → suggested size: ${units.toFixed(4)} units of ${row.pair}`,
    { show_alert: true },
  );
});

// Real order placement — every check below runs BEFORE any money moves.
bot.action(/^mt5:place:(\d+)$/, async (ctx) => {
  const [, signalId] = ctx.match;

  if (!isAdmin(ctx)) return ctx.answerCbQuery('Not authorized.');
  if (!(await isTradingEnabled())) {
    return ctx.answerCbQuery('Trading is disabled — run /enabletrading first.', { show_alert: true });
  }

  const { rows } = await db.query('SELECT * FROM signals WHERE id = $1', [signalId]);
  const row = rows[0];
  if (!row || row.direction === 'NO_TRADE') {
    return ctx.answerCbQuery('Signal not found or not tradeable.', { show_alert: true });
  }

  const mt5Symbol = mt5.mapSymbol(row.pair);
  if (!mt5Symbol) {
    return ctx.answerCbQuery(`No MT5 symbol mapped for ${row.pair}.`, { show_alert: true });
  }

  const openCount = await db.countOpenMt5Trades();
  if (openCount >= MT5_MAX_OPEN_POSITIONS) {
    return ctx.answerCbQuery(`Max open positions reached (${MT5_MAX_OPEN_POSITIONS}).`, { show_alert: true });
  }

  const todayPnl = await db.getTodayClosedPnl();
  if (todayPnl <= MT5_MAX_DAILY_LOSS) {
    return ctx.answerCbQuery(`Daily loss cap hit (${todayPnl.toFixed(2)} ≤ ${MT5_MAX_DAILY_LOSS}). No new trades today.`, { show_alert: true });
  }

  await ctx.answerCbQuery('Placing order on MT5…');

  const entry = (row.entry_zone_low + row.entry_zone_high) / 2;
  const stopDistance = Math.abs(entry - row.stop_loss);
  const takeDistance = Math.abs(row.take_profit - entry);

  try {
    const result = await mt5.placeTrade({
      pair: row.pair,
      direction: row.direction,
      lotSize: MT5_LOT_SIZE,
      stopDistance,
      takeDistance,
    });

    await db.insertMt5Trade({
      signalId: row.id,
      ticket: result.ticket,
      mt5Symbol: result.mt5Symbol,
      direction: row.direction,
      lotSize: MT5_LOT_SIZE,
      openPrice: result.openPrice,
      stopLoss: result.stopLoss,
      takeProfit: result.takeProfit,
      openedBy: String(ctx.from.id),
    });

    await ctx.editMessageReplyMarkup(
      Markup.inlineKeyboard([styledButton('✅ Trade Placed', 'noop', 'success')]).reply_markup,
    );
    await ctx.reply(
      `📈 Order placed: ${row.direction} ${MT5_LOT_SIZE} ${result.mt5Symbol}\n`
      + `Fill: ~${result.openPrice}\nSL: ${result.stopLoss}\nTP: ${result.takeProfit}\n`
      + `Ticket: ${result.ticket}`,
    );
  } catch (err) {
    logger.error(`MT5 place trade failed: ${err.message}`);
    await ctx.reply(`⚠️ Order failed: ${err.message}`);
  }
});

// Closing a position from /positions
bot.action(/^mt5:close:(\d+)$/, async (ctx) => {
  const [, tradeRowId] = ctx.match;
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Not authorized.');

  const { rows } = await db.query('SELECT * FROM mt5_trades WHERE id = $1', [tradeRowId]);
  const trade = rows[0];
  if (!trade || trade.status !== 'open') {
    return ctx.answerCbQuery('Trade not found or already closed.', { show_alert: true });
  }

  await ctx.answerCbQuery('Closing position…');
  try {
    const result = await mt5.closePosition(trade.ticket);
    const pnl = result?.profit ?? 0;
    await db.closeMt5Trade(trade.id, pnl);
    await ctx.editMessageReplyMarkup(
      Markup.inlineKeyboard([styledButton(`✅ Closed (${pnl.toFixed(2)})`, 'noop')]).reply_markup,
    );
  } catch (err) {
    logger.error(`MT5 close position failed: ${err.message}`);
    await ctx.reply(`⚠️ Close failed: ${err.message}`);
  }
});

async function pushSignal(signal) {
  const id = await db.insertSignal(signal);
  const text = formatSignal(signal);
  if (!text) return; // NO_TRADE, nothing to send

  const buttons = [
    styledButton('✅ Mark Taken', `signal:${id}:taken`, 'success'),
    styledButton('❌ Ignore', `signal:${id}:ignored`, 'danger'),
  ];
  if (mt5.isConfigured() && mt5.mapSymbol(signal.pair)) {
    buttons.push(styledButton('📈 Place Trade (MT5)', `mt5:place:${id}`));
  }
  buttons.push(styledButton('💰 Position Size', `calc:${id}`));

  await bot.telegram.sendMessage(CHAT_ID, text, Markup.inlineKeyboard(buttons));
  logger.info(`Signal #${id} sent for ${signal.pair}`);
}

async function isPaused() {
  const state = await db.getBotState('paused', { value: false });
  return state.value === true;
}

async function isTradingEnabled() {
  const state = await db.getBotState('trading_enabled', { value: false });
  return state.value === true;
}

async function recordScan(pairsScanned, signalsFired) {
  await db.setBotState('last_scan', {
    at: new Date().toISOString(), pairsScanned, signalsFired,
  });
}

module.exports = {
  bot, pushSignal, isPaused, isTradingEnabled, registerCommands, recordScan, getWatchlist, setWatchlist,
};
