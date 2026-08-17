require('dotenv').config();

const fs = require('fs');
const path = require('path');
const exchange = require('../services/exchange');
const signalEngine = require('../engine/signalEngine');
const { formatScanBlock } = require('../bot/format');
const logger = require('../utils/logger');

// Backtest-specific env, each falling back to the live scanner's env vars,
// then to a hardcoded default — so you can point this at the exact same
// universe the live bot scans just by running `npm run backtest`, or
// override just the backtest side (e.g. widen history) without touching
// the live config.
const EXCHANGES = (process.env.BACKTEST_EXCHANGES || process.env.EXCHANGES || 'binance,bybit')
  .split(',').map((s) => s.trim());
const PAIRS = (process.env.BACKTEST_PAIRS || process.env.PAIRS || 'BTC/USDT,ETH/USDT,SOL/USDT')
  .split(',').map((s) => s.trim());
const TIMEFRAMES = (process.env.BACKTEST_TIMEFRAMES || process.env.TIMEFRAMES || '15m,1h')
  .split(',').map((s) => s.trim());

// How many raw candles to pull per timeframe, once, up front (not re-fetched
// per step). ccxt/exchange limits apply — most exchanges cap a single
// fetchOHLCV call around 1000-1500 candles.
const HISTORY_CANDLES = Number(process.env.BACKTEST_CANDLES || 1000);
// Matches the live engine's lookback window (src/engine/signalEngine.js
// calls exchange.getCandles(..., 200)) so trend/S-R/momentum are computed
// over the same amount of history at every step.
const WINDOW = Number(process.env.BACKTEST_WINDOW || 200);
// Confidence bar used to pick "qualifying" example signals for the report.
// Deliberately independent of the live MIN_SIGNAL_SCORE env var (which may
// itself be misconfigured) — this always shows genuine >=70 examples.
const REPORT_MIN_SCORE = Number(process.env.BACKTEST_MIN_SCORE || 70);
const MAX_EXAMPLES_PER_DIRECTION = Number(process.env.BACKTEST_MAX_EXAMPLES || 3);
const OUTPUT_PATH = process.env.BACKTEST_OUTPUT || path.join(__dirname, '../../data/backtest-results.json');

/**
 * Return the last `window` candles from `candles` whose time is <= asOfTime.
 * Used to align higher timeframes (fewer, longer candles) to the same
 * point in simulated time as the entry timeframe's walk-forward index.
 */
function sliceAsOf(candles, asOfTime, window) {
  let end = candles.length;
  while (end > 0 && candles[end - 1].time > asOfTime) end -= 1;
  const start = Math.max(0, end - window);
  return candles.slice(start, end);
}

async function backtestPair(exchangeName, pair) {
  logger.info(`Fetching ${HISTORY_CANDLES} historical candles — ${exchangeName}:${pair} across ${TIMEFRAMES.join(', ')}`);

  const candlesByTf = {};
  for (const tf of TIMEFRAMES) {
    // eslint-disable-next-line no-await-in-loop
    candlesByTf[tf] = await exchange.getCandles(exchangeName, pair, tf, HISTORY_CANDLES);
  }

  const entryTf = TIMEFRAMES[0];
  const entryCandles = candlesByTf[entryTf];
  const results = [];

  for (let i = WINDOW; i < entryCandles.length; i += 1) {
    const asOfTime = entryCandles[i].time;
    const perTf = {};
    let haveEnoughHistory = true;

    for (const tf of TIMEFRAMES) {
      const windowSlice = sliceAsOf(candlesByTf[tf], asOfTime, WINDOW);
      // findSwingPoints needs a minimum span either side of a candle to
      // confirm a swing high/low — too thin a slice just means "not enough
      // history yet for this timeframe at this point in time", skip the step.
      if (windowSlice.length < 30) { haveEnoughHistory = false; break; }
      perTf[tf] = signalEngine.buildTfData(windowSlice);
    }
    if (!haveEnoughHistory) continue;

    // No historical bid/ask spread data exists for a single OHLCV feed, so
    // this uses the entry-timeframe close as both bid and ask (spreadPips
    // = 0). That means the live SPREAD_LIMIT_PIPS filter never rejects a
    // backtest step — a real-time signal could still be filtered by spread
    // where this backtest wasn't. Everything downstream of that (trend,
    // breakout, momentum, confluence score, SL/TP/R:R) uses the same logic
    // as the live engine.
    const closePrice = entryCandles[i].close;
    const price = { bid: closePrice, ask: closePrice };

    const result = signalEngine.evaluateFromData({
      exchangeName, pair, timeframes: TIMEFRAMES, perTf, price, spreadPips: 0,
    });

    if (result.direction !== 'NO_TRADE') {
      results.push({ ...result, backtestTime: new Date(asOfTime).toISOString() });
    }
  }

  return results;
}

function summarize(allResults) {
  const buy = allResults.filter((r) => r.direction === 'BUY');
  const sell = allResults.filter((r) => r.direction === 'SELL');
  const qualifyingBuy = buy.filter((r) => r.confidence >= REPORT_MIN_SCORE)
    .sort((a, b) => b.confidence - a.confidence);
  const qualifyingSell = sell.filter((r) => r.confidence >= REPORT_MIN_SCORE)
    .sort((a, b) => b.confidence - a.confidence);

  return {
    totalSignals: allResults.length,
    buyCount: buy.length,
    sellCount: sell.length,
    qualifyingBuy,
    qualifyingSell,
  };
}

async function main() {
  logger.info(`Backtest starting — exchanges: ${EXCHANGES.join(', ')} | pairs: ${PAIRS.join(', ')} | timeframes: ${TIMEFRAMES.join(', ')}`);
  logger.info(`History: ${HISTORY_CANDLES} candles/tf | window: ${WINDOW} | report threshold: >=${REPORT_MIN_SCORE}`);
  logger.info('Read-only: no Telegram messages, no MT5/exchange orders, no DB writes.');

  const allResults = [];
  for (const exchangeName of EXCHANGES) {
    for (const pair of PAIRS) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const results = await backtestPair(exchangeName, pair);
        allResults.push(...results);
        logger.info(`${exchangeName}:${pair} — ${results.length} non-NO_TRADE signals across the walk-forward run`);
      } catch (err) {
        logger.error(`Backtest failed for ${exchangeName}:${pair}: ${err.message}`);
      }
    }
  }

  const summary = summarize(allResults);

  console.log('\n=========== BACKTEST SUMMARY ===========');
  console.log(`Total signals fired (any confidence): ${summary.totalSignals}  (BUY ${summary.buyCount} / SELL ${summary.sellCount})`);
  console.log(`Qualifying at >=${REPORT_MIN_SCORE}: BUY ${summary.qualifyingBuy.length} / SELL ${summary.qualifyingSell.length}`);
  console.log('=========================================\n');

  if (!summary.qualifyingBuy.length && !summary.qualifyingSell.length) {
    console.log(`No signal in this history cleared >=${REPORT_MIN_SCORE} confidence in either direction.`);
    console.log('This can be a legitimate result (conflicting timeframes cap the score often — see the live NO_TRADE');
    console.log('reasoning strings), not necessarily a bug. Try a wider pair/timeframe set or more history via');
    console.log('BACKTEST_PAIRS / BACKTEST_TIMEFRAMES / BACKTEST_CANDLES to get examples faster.');
  }

  if (summary.qualifyingBuy.length) {
    console.log(`--- Example >=${REPORT_MIN_SCORE} BUY signal${summary.qualifyingBuy.length > 1 ? 's' : ''} ---\n`);
    summary.qualifyingBuy.slice(0, MAX_EXAMPLES_PER_DIRECTION).forEach((sig) => {
      console.log(`[as of ${sig.backtestTime}]`);
      console.log(formatScanBlock(sig));
      console.log('');
    });
  }

  if (summary.qualifyingSell.length) {
    console.log(`--- Example >=${REPORT_MIN_SCORE} SELL signal${summary.qualifyingSell.length > 1 ? 's' : ''} ---\n`);
    summary.qualifyingSell.slice(0, MAX_EXAMPLES_PER_DIRECTION).forEach((sig) => {
      console.log(`[as of ${sig.backtestTime}]`);
      console.log(formatScanBlock(sig));
      console.log('');
    });
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({
    config: {
      exchanges: EXCHANGES, pairs: PAIRS, timeframes: TIMEFRAMES, historyCandles: HISTORY_CANDLES, window: WINDOW, reportMinScore: REPORT_MIN_SCORE,
    },
    summary: {
      totalSignals: summary.totalSignals, buyCount: summary.buyCount, sellCount: summary.sellCount,
    },
    allSignals: allResults,
  }, null, 2));
  logger.info(`Full results written to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  logger.error(`Fatal backtest error: ${err.message}`);
  process.exit(1);
});
