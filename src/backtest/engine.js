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

/**
 * Walk forward from the bar AFTER the signal was generated (signalIndex + 1)
 * to see whether price hits takeProfit or stopLoss first. This intentionally
 * uses "future" candles relative to the signal — that's not look-ahead bias,
 * it's the whole point of a backtest: the signal itself was built using only
 * data available as of signalIndex (see sliceAsOf above), and we're now
 * simulating what happened to a trade taken at that moment. Look-ahead bias
 * would be using these future candles to help decide direction/entry/SL/TP —
 * this function never touches those, it only reads outcome.
 */
function evaluateOutcome(entryCandles, signalIndex, signal) {
  const { direction, stopLoss, takeProfit } = signal;

  for (let j = signalIndex + 1; j < entryCandles.length; j += 1) {
    const c = entryCandles[j];
    const hitTP = direction === 'BUY' ? c.high >= takeProfit : c.low <= takeProfit;
    const hitSL = direction === 'BUY' ? c.low <= stopLoss : c.high >= stopLoss;

    if (hitTP && hitSL) {
      // Both levels were touched within the same candle. OHLC data alone
      // can't tell us which happened first intra-candle, so we assume SL
      // first — the conservative assumption that doesn't overstate results.
      return {
        outcome: 'SL', exitTime: c.time, barsHeld: j - signalIndex, ambiguous: true,
      };
    }
    if (hitTP) return { outcome: 'TP', exitTime: c.time, barsHeld: j - signalIndex, ambiguous: false };
    if (hitSL) return { outcome: 'SL', exitTime: c.time, barsHeld: j - signalIndex, ambiguous: false };
  }

  // Ran out of history before either level was reached.
  return {
    outcome: 'OPEN', exitTime: null, barsHeld: entryCandles.length - 1 - signalIndex, ambiguous: false,
  };
}

async function backtestPair({
  exchangeName, pair, timeframes, historyCandles, window, assumedSpreadPips,
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

    // No historical bid/ask feed exists for a single OHLCV series — a real
    // per-candle spread genuinely isn't recoverable after the fact. Rather
    // than hardcoding spreadPips=0 (which permanently disables the live
    // SPREAD_LIMIT_PIPS filter — same code, but a constant that can never
    // trip it), we run the exact same evaluateFromData() with a configurable
    // assumed spread (BACKTEST_ASSUMED_SPREAD_PIPS, default 0). That keeps
    // every code path identical to live; only the input value is a stand-in.
    // If you want the spread filter meaningfully exercised in the backtest,
    // set BACKTEST_ASSUMED_SPREAD_PIPS to a realistic typical spread for
    // the pairs you're testing.
    const closePrice = entryCandles[i].close;
    const price = { bid: closePrice, ask: closePrice };

    const result = signalEngine.evaluateFromData({
      exchangeName, pair, timeframes, perTf, price, spreadPips: assumedSpreadPips,
    });

    if (result.direction !== 'NO_TRADE') {
      const { outcome, exitTime, barsHeld, ambiguous } = evaluateOutcome(entryCandles, i, result);
      const pnlR = outcome === 'TP' ? result.riskReward : (outcome === 'SL' ? -1 : null);

      results.push({
        ...result,
        backtestTime: new Date(asOfTime).toISOString(),
        outcome, // 'TP' | 'SL' | 'OPEN'
        exitTime: exitTime ? new Date(exitTime).toISOString() : null,
        barsHeld,
        pnlR, // in R-multiples: +riskReward on TP, -1 on SL, null if still OPEN
        outcomeAmbiguous: ambiguous,
      });
    }
  }

  return results;
}

/**
 * Aggregate trade-level stats from a set of already-evaluated signals.
 * Trades are sorted chronologically by backtestTime so win-rate, P/L, and
 * drawdown reflect the order signals actually fired in, even though the
 * caller may hand us results concatenated across multiple pairs/exchanges.
 *
 * Note on maxDrawdown: this models a simple sequential equity curve —
 * one unit of risk (1R) per trade, applied in signal order — not real
 * position sizing or concurrent/overlapping open trades. Treat it as a
 * relative measure of how streaky the strategy's losses are, not a claim
 * about actual account drawdown.
 */
function computeTradeStats(trades) {
  const sorted = [...trades].sort((a, b) => a.backtestTime.localeCompare(b.backtestTime));
  const decided = sorted.filter((t) => t.outcome === 'TP' || t.outcome === 'SL');
  const wins = decided.filter((t) => t.outcome === 'TP');
  const losses = decided.filter((t) => t.outcome === 'SL');
  const openTrades = sorted.length - decided.length;

  const totalPL = decided.reduce((sum, t) => sum + t.pnlR, 0);
  const winRate = decided.length ? (wins.length / decided.length) * 100 : null;

  // Average PLANNED R:R at entry across every signal taken (win, loss, or
  // still open) — this is the setup's risk:reward ratio, not the realized
  // outcome (that's totalPL/winRate above).
  const avgRR = sorted.length
    ? sorted.reduce((sum, t) => sum + t.riskReward, 0) / sorted.length
    : null;

  let peak = 0;
  let cum = 0;
  let maxDrawdown = 0;
  decided.forEach((t) => {
    cum += t.pnlR;
    if (cum > peak) peak = cum;
    maxDrawdown = Math.max(maxDrawdown, peak - cum);
  });

  return {
    totalTrades: decided.length,
    openTrades,
    wins: wins.length,
    losses: losses.length,
    winRate,
    totalPL,
    avgRR,
    maxDrawdown,
    trades: sorted,
  };
}

function summarize(allResults, reportMinScore) {
  const buy = allResults.filter((r) => r.direction === 'BUY');
  const sell = allResults.filter((r) => r.direction === 'SELL');
  const qualifyingBuy = buy.filter((r) => r.confidence >= reportMinScore)
    .sort((a, b) => b.confidence - a.confidence);
  const qualifyingSell = sell.filter((r) => r.confidence >= reportMinScore)
    .sort((a, b) => b.confidence - a.confidence);
  const qualifying = allResults.filter((r) => r.confidence >= reportMinScore);

  return {
    totalSignals: allResults.length,
    buyCount: buy.length,
    sellCount: sell.length,
    qualifyingBuy,
    qualifyingSell,
    // Stats over every signal the engine fired, regardless of score.
    statsAll: computeTradeStats(allResults),
    // Stats over only signals that clear reportMinScore — this is the set
    // that matters, since it's what the live bot would actually have sent.
    statsQualifying: computeTradeStats(qualifying),
  };
}

/**
 * Run a walk-forward backtest across the given exchanges/pairs/timeframes.
 * Read-only: fetches historical OHLCV only — no orders, no Telegram sends,
 * no DB writes. Returns { config, allResults, summary }; callers (CLI
 * script, Telegram /backtest command) decide how to present/store it.
 */
async function runBacktest({
  exchanges, pairs, timeframes, historyCandles = 1000, window = 200, reportMinScore = 70, assumedSpreadPips = 0,
}) {
  const allResults = [];
  const errors = [];

  for (const exchangeName of exchanges) {
    for (const pair of pairs) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const results = await backtestPair({
          exchangeName, pair, timeframes, historyCandles, window, assumedSpreadPips,
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
      exchanges, pairs, timeframes, historyCandles, window, reportMinScore, assumedSpreadPips,
    },
    allResults,
    summary,
    errors,
  };
}

module.exports = {
  runBacktest, sliceAsOf, evaluateOutcome, computeTradeStats,
};
