const { Telegraf, Markup } = require('telegraf');
const { formatSignal, formatStats } = require('./format');
const db = require('../db/pool');
const exchange = require('../services/exchange');
const logger = require('../utils/logger');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ADMIN_IDS = (process.env.TELEGRAM_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const EXCHANGES = (process.env.EXCHANGES || 'binance,bybit').split(',').map((s) => s.trim());

function isAdmin(ctx) {
  return ADMIN_IDS.includes(String(ctx.from.id));
}

// Telegram only shows a command list in the UI (the "/" menu, and the
// hamburger next to the message box) if you register it explicitly — having
// bot.command() handlers alone doesn't do that. This runs once at launch.
const COMMAND_LIST = [
  { command: 'start', description: 'Show what this bot does' },
  { command: 'status', description: 'Bot + exchange connection status' },
  { command: 'stats', description: 'Win rate and net pips (optionally: /stats 7)' },
  { command: 'pause', description: 'Stop signal scanning (admin)' },
  { command: 'resume', description: 'Resume signal scanning (admin)' },
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
    + 'and posts them here. Signals only right now, no auto-trading.\n\n'
    + 'Use the menu button (☰) or type a command below.',
  );
});

bot.command('status', async (ctx) => {
  const paused = await db.getBotState('paused', { value: false });
  const connections = await Promise.all(
    EXCHANGES.map(async (name) => `${name}: ${(await exchange.isConnected(name)) ? '🟢' : '🔴'}`),
  );
  await ctx.reply(
    `Bot status: ${paused.value ? '⏸ paused' : '▶️ running'}\n${connections.join('\n')}`,
    Markup.inlineKeyboard([
      paused.value
        ? styledButton('▶️ Resume', 'admin:resume', 'success')
        : styledButton('⏸ Pause', 'admin:pause', 'danger'),
      styledButton('🔄 Refresh', 'status:refresh'),
    ]),
  );
});

bot.command('stats', async (ctx) => {
  const days = Number(ctx.message.text.split(' ')[1]) || 30;
  const stats = await db.getStats(days);
  ctx.reply(formatStats(stats, days));
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

async function pushSignal(signal) {
  const id = await db.insertSignal(signal);
  const text = formatSignal(signal);
  if (!text) return; // NO_TRADE, nothing to send

  await bot.telegram.sendMessage(CHAT_ID, text, Markup.inlineKeyboard([
    styledButton('✅ Mark Taken', `signal:${id}:taken`, 'success'),
    styledButton('❌ Ignore', `signal:${id}:ignored`, 'danger'),
  ]));
  logger.info(`Signal #${id} sent for ${signal.pair}`);
}

async function isPaused() {
  const state = await db.getBotState('paused', { value: false });
  return state.value === true;
}

module.exports = { bot, pushSignal, isPaused, registerCommands };
