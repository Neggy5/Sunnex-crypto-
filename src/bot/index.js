const { Telegraf, Markup } = require('telegraf');
const { formatSignal, formatStats } = require('./format');
const db = require('../db/pool');
const exchange = require('../services/exchange');
const mt5 = require('../services/mt5');
const signalEngine = require('../engine/signalEngine');
const logger = require('../utils/logger');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ADMIN_IDS = (process.env.TELEGRAM_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const EXCHANGES = (process.env.EXCHANGES || 'binance,bybit').split(',').map((s) => s.trim());
const PAIRS = (process.env.PAIRS || 'BTC/USDT,ETH/USDT').split(',').map((s) => s.trim());
const TIMEFRAMES = (process.env.TIMEFRAMES || '15m,1h').split(',').map((s) => s.trim());

// MT5 live-trading config — all guarded by an explicit /enabletrading gate
// (bot_state.trading_enabled) that defaults OFF, independent of whether
// MetaApi credentials are even configured. Nothing places a real order
// until an admin turns this on explicitly, every single deploy.
const MT5_LOT_SIZE = Number(process.env.MT5_LOT_SIZE || 0.01);
const MT5_MAX_OPEN_POSITIONS = Number(process.env.MT5_MAX_OPEN_POSITIONS || 3);
const MT5_MAX_DAILY_LOSS = Number(process.env.MT5_MAX_DAILY_LOSS || -50); // account currency, negative

function isAdmin(ctx) {
  return ADMIN_IDS.includes(String(ctx.from.id));
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
  { command: 'scan', description: 'Run an immediate scan and show results (admin)' },
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

bot.command('price', async (ctx) => {
  const arg = ctx.message.text.split(' ')[1]?.toUpperCase();
  const requestedPair = arg ? (arg.includes('/') ? arg : `${arg}/USDT`) : null;
  const pairsToFetch = requestedPair ? [requestedPair] : PAIRS;

  const rows = [];
  for (const pair of pairsToFetch) {
    for (const exchangeName of EXCHANGES) {
      try {
        const { bid, ask } = await exchange.getPrice(exchangeName, pair);
        const mid = (bid + ask) / 2;
        rows.push(`${exchangeName}: ${pair} — ${mid.toFixed(mid < 10 ? 5 : 2)} (bid ${bid} / ask ${ask})`);
      } catch (err) {
        rows.push(`${exchangeName}: ${pair} — unavailable (${err.message})`);
      }
    }
  }

  if (!rows.length) return ctx.reply(`No price data for ${requestedPair || 'configured pairs'}.`);
  await ctx.reply(`💹 Live prices\n\n${rows.join('\n')}`);
});

bot.command('stats', async (ctx) => {
  const days = Number(ctx.message.text.split(' ')[1]) || 30;
  const stats = await db.getStats(days);
  ctx.reply(formatStats(stats, days));
});

bot.command('scan', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  await ctx.reply(`🔎 Scanning ${EXCHANGES.length * PAIRS.length} exchange/pair combo(s) live — this hits Binance/Bybit for real, may take a few seconds…`);

  const lines = [];
  let signalsFired = 0;
  for (const exchangeName of EXCHANGES) {
    for (const pair of PAIRS) {
      try {
        const signal = await signalEngine.evaluatePair(exchangeName, pair, TIMEFRAMES);
        if (signal.direction === 'NO_TRADE') {
          await db.insertSignal(signal);
          lines.push(`⚪ ${exchangeName}:${pair} — no trade (${signal.reasoning})`);
        } else {
          signalsFired += 1;
          lines.push(`🟢 ${exchangeName}:${pair} — ${signal.direction} @ ${signal.confidence}% confidence`);
          await pushSignal(signal); // inserts + posts to chat
        }
      } catch (err) {
        lines.push(`🔴 ${exchangeName}:${pair} — error: ${err.message}`);
      }
    }
  }

  await recordScan(PAIRS.length * EXCHANGES.length, signalsFired);
  await ctx.reply(`Scan complete:\n\n${lines.join('\n')}`);
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
  bot, pushSignal, isPaused, isTradingEnabled, registerCommands, recordScan,
};
