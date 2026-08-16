const cron = require('node-cron');
const signalEngine = require('./engine/signalEngine');
const { pushSignal, isPaused } = require('./bot/index');
const logger = require('./utils/logger');

const EXCHANGES = (process.env.EXCHANGES || 'binance,bybit').split(',').map((s) => s.trim());
const PAIRS = (process.env.PAIRS || 'BTC/USDT,ETH/USDT').split(',').map((s) => s.trim());
const TIMEFRAMES = (process.env.TIMEFRAMES || '15m,1h').split(',').map((s) => s.trim());

async function scanOnce() {
  if (await isPaused()) {
    logger.info('Scan skipped — bot paused');
    return;
  }

  for (const exchangeName of EXCHANGES) {
    for (const pair of PAIRS) {
      try {
        const signal = await signalEngine.evaluatePair(exchangeName, pair, TIMEFRAMES);
        await pushSignal(signal);
      } catch (err) {
        logger.error(`Scan failed for ${exchangeName}:${pair}: ${err.message}`);
      }
    }
  }
}

function start() {
  // every 15 min — adjust to match your fastest configured timeframe
  cron.schedule('*/15 * * * *', scanOnce);
  logger.info(`Scanner scheduled (every 15 min) — exchanges: ${EXCHANGES.join(', ')}`);
}

module.exports = { start, scanOnce };
