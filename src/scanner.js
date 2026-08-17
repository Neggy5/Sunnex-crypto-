const cron = require('node-cron');
const signalEngine = require('./engine/signalEngine');
const {
  pushSignal, isPaused, recordScan, getWatchlist,
} = require('./bot/index');
const logger = require('./utils/logger');

const EXCHANGES = (process.env.EXCHANGES || 'binance,bybit').split(',').map((s) => s.trim());
const TIMEFRAMES = (process.env.TIMEFRAMES || '15m,1h').split(',').map((s) => s.trim());

async function scanOnce() {
  if (await isPaused()) {
    logger.info('Scan skipped — bot paused');
    return;
  }

  const pairs = await getWatchlist();
  let signalsFired = 0;
  for (const exchangeName of EXCHANGES) {
    for (const pair of pairs) {
      try {
        const signal = await signalEngine.evaluatePair(exchangeName, pair, TIMEFRAMES);
        if (signal.direction !== 'NO_TRADE') signalsFired += 1;
        await pushSignal(signal);
      } catch (err) {
        logger.error(`Scan failed for ${exchangeName}:${pair}: ${err.message}`);
      }
    }
  }
  await recordScan(EXCHANGES.length * pairs.length, signalsFired);
}

function start() {
  // every 15 min — adjust to match your fastest configured timeframe
  cron.schedule('*/15 * * * *', scanOnce);
  logger.info(`Scanner scheduled (every 15 min) — exchanges: ${EXCHANGES.join(', ')}`);

  startDailyDigest();
}

// New: posts a daily summary to the chat, on top of the existing 15-min
// scan cron above — doesn't touch or replace it.
const DIGEST_HOUR = Number(process.env.DIGEST_HOUR_UTC ?? 21); // 0-23, UTC

function startDailyDigest() {
  cron.schedule(`0 ${DIGEST_HOUR} * * *`, async () => {
    try {
      // eslint-disable-next-line global-require
      const db = require('./db/pool');
      // eslint-disable-next-line global-require
      const { bot } = require('./bot/index');
      // eslint-disable-next-line global-require
      const { formatDigest } = require('./bot/format');

      const statsToday = await db.getStats(1);
      const leaderboard = await db.getPairLeaderboard(1);
      const text = formatDigest({ statsToday, leaderboard });
      await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, text);
      logger.info('Daily digest posted');
    } catch (err) {
      logger.error(`Daily digest failed: ${err.message}`);
    }
  });
  logger.info(`Daily digest scheduled for ${DIGEST_HOUR}:00 UTC`);
}

module.exports = { start, scanOnce };
