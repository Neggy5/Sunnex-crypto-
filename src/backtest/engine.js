const exchange = require('../services/exchange');
const signalEngine = require('../engine/signalEngine');
const logger = require('../utils/logger');

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

async function backtestPair({
  exchangeName, pair, timeframes, historyCandles, window,
}) {
  logger.info(`Fetching ${historyCandles} historical candles — ${exchangeName}:${pair} across ${timeframes.join(', ')}`);

  const candlesByTf = {};
  for (const tf of timeframes) {
    // eslint-disable-next-line no-await-in-loop
    candlesByTf[tf] = await exchange.getCandles(exchangeName, pair, tf, historyCandles);
  }

  const entryTf = timeframes[0];
  const entryCandles = candlesByTf[entryTf];
  const results = [];

  for (let i = window; i < entryCandles.length; i += 1) {
    const asOfTime = entryCandles[i].time;
    const perTf = {};
    let haveEnoughHistory = true;

    for (const tf of timeframes) {
      const windowSlice = sliceAsOf(candlesByTf[tf], asOfTime, window);
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
      exchangeName, pair, timeframes, perTf, price, spreadPips: 0,
    });

    if (result.direction !== 'NO_TRADE') {
      results.push({ ...result, backtestTime: new Date(asOfTime).toISOString() });
    }
  }

  return results;
}

function summarize(allResults, reportMinScore) {
  const buy = allResults.filter((r) => r.direction === 'BUY');
  const sell = allResults.filter((r) => r.direction === 'SELL');
  const qualifyingBuy = buy.filter((r) => r.confidence >= reportMinScore)
    .sort((a, b) => b.confidence - a.confidence);
  const qualifyingSell = sell.filter((r) => r.confidence >= reportMinScore)
    .sort((a, b) => b.confidence - a.confidence);

  return {
    totalSignals: allResults.length,
    buyCount: buy.length,
    sellCount: sell.length,
    qualifyingBuy,
    qualifyingSell,
  };
}

/**
 * Run a walk-forward backtest across the given exchanges/pairs/timeframes.
 * Read-only: fetches historical OHLCV only — no orders, no Telegram sends,
 * no DB writes. Returns { config, allResults, summary }; callers (CLI
 * script, Telegram /backtest command) decide how to present/store it.
 */
async function runBacktest({
  exchanges, pairs, timeframes, historyCandles = 1000, window = 200, reportMinScore = 70,
}) {
  const allResults = [];
  const errors = [];

  for (const exchangeName of exchanges) {
    for (const pair of pairs) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const results = await backtestPair({
          exchangeName, pair, timeframes, historyCandles, window,
        });
        allResults.push(...results);
        logger.info(`${exchangeName}:${pair} — ${results.length} non-NO_TRADE signals across the walk-forward run`);
      } catch (err) {
        logger.error(`Backtest failed for ${exchangeName}:${pair}: ${err.message}`);
        errors.push({ exchangeName, pair, message: err.message });
      }
    }
  }

  const summary = summarize(allResults, reportMinScore);

  return {
    config: {
      exchanges, pairs, timeframes, historyCandles, window, reportMinScore,
    },
    allResults,
    summary,
    errors,
  };
}

module.exports = { runBacktest, sliceAsOf };
