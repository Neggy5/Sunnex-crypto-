require('dotenv').config();
const express = require('express');
const { bot, registerCommands } = require('./bot/index');
const scanner = require('./scanner');
const exchange = require('./services/exchange');
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

  await bot.launch();
  await registerCommands();
  logger.info('Sunnex Crypto bot launched');

  scanner.start();

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main().catch((err) => {
  logger.error(`Fatal startup error: ${err.message}`);
  process.exit(1);
});
