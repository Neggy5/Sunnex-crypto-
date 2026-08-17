require('dotenv').config();
const express = require('express');
const { bot, registerCommands } = require('./bot/index');
const scanner = require('./scanner');
const exchange = require('./services/exchange');
const mt5 = require('./services/mt5');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 3000;
const EXCHANGES = (process.env.EXCHANGES || 'binance,bybit').split(',').map((s) => s.trim());

app.get('/health', async (req, res) => {
  const connections = {};
  await Promise.all(EXCHANGES.map(async (name) => {
    connections[name] = await exchange.isConnected(name).catch(() => false);
  }));
  res.json({
    status: 'ok', bot: 'sunnex-crypto', connections, timestamp: new Date().toISOString(),
  });
});

async function main() {
  app.listen(PORT, () => logger.info(`Health check listening on :${PORT}`));

  // registerCommands() must run BEFORE bot.launch() — launch() blocks
  // forever (by design, to keep the polling loop alive) so anything
  // awaited after it never runs.
  await registerCommands();
  bot.launch().catch((err) => logger.error(`Bot launch error: ${err.message}`));
  logger.info('Sunnex Crypto bot launched');

  // MT5 connects in the background — takes several seconds and shouldn't
  // block the bot from responding to Telegram in the meantime. Trading
  // stays gated behind /enabletrading regardless of connection state.
  if (mt5.isConfigured()) {
    mt5.connect()
      .then(() => logger.info('MT5 connected.'))
      .catch((err) => logger.error(`MT5 connection failed at startup: ${err.message}`));
  } else {
    logger.info('MT5 not configured — live trading features disabled.');
  }

  scanner.start();

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main().catch((err) => {
  logger.error(`Fatal startup error: ${err.message}`);
  process.exit(1);
});
