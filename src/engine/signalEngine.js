const analysis = require('./analysis');
const exchange = require('../services/exchange');
const logger = require('../utils/logger');

// Number(process.env.X || fallback) silently produces NaN if X is set but
// malformed (extra whitespace, a stray unit, etc). That's dangerous here
// specifically: `score < NaN` and `riskReward < NaN` both evaluate to
// false in JS, meaning a NaN threshold doesn't fail closed — it disables
// the filter entirely and lets every signal through. Guard against that.
function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    logger.error(`${name}="${raw}" is not a valid number — falling back to ${fallback}. Fix this env var.`);
    return fallback;
  }
  return n;
}

const MIN_SIGNAL_SCORE = numEnv('MIN_SIGNAL_SCORE', 70);
const MIN_RR = numEnv('MIN_RR', 1.5);
const SPREAD_LIMIT_PIPS = numEnv('SPREAD_LIMIT_PIPS', 3);

/**
 * Build the per-timeframe analysis bundle (trend/S-R/breakout/volatility/
 * momentum) from a raw candle array. Pure — no I/O — so both the live path
 * and the backtest runner (src/backtest/run.js) can produce identical
 * shapes, one from exchange.getCandles(), the other from historical candles
 * fetched once and sliced into walk-forward windows.
 */
function buildTfData(candles) {
  const trend = analysis.detectTrend(candles);
  const sr = analysis.findSupportResistance(candles);
  const breakout = analysis.detectBreakout(candles, sr);
  const volatility = analysis.calcVolatility(candles);
  const momentum = analysis.calcMomentum(candles);
  return {
    trend, sr, breakout, volatility, momentum, candles,
  };
}

/**
 * Pure scoring step: given already-built per-timeframe data and a price,
 * decide BUY / SELL / NO_TRADE. No exchange calls — this is what makes the
 * engine backtestable, since the backtest runner can call this directly
 * with historical candles instead of live ones.
 */
function evaluateFromData({
  exchangeName, pair, timeframes, perTf, price, spreadPips,
}) {
  if (spreadPips > SPREAD_LIMIT_PIPS) {
    return noTrade(exchangeName, pair, `Spread too wide (${spreadPips.toFixed(1)} pips > ${SPREAD_LIMIT_PIPS})`);
  }

  const { score, direction, reasons, scoreDetail } = scoreConfluence(perTf, timeframes);

  if (score < MIN_SIGNAL_SCORE || direction === 'NONE') {
    return noTrade(exchangeName, pair, reasons.join('; ') || 'Insufficient confluence', scoreDetail, score);
  }

  const entryTf = perTf[timeframes[0]];
  const { stopLoss, takeProfit, riskReward } = buildSlTp(entryTf, direction, price);

  if (riskReward < MIN_RR) {
    return noTrade(exchangeName, pair, `R:R ${riskReward.toFixed(2)} below minimum ${MIN_RR}`, scoreDetail, score);
  }

  return {
    exchange: exchangeName,
    pair,
    timeframe: timeframes[0],
    direction,
    confidence: score,
    entryZoneLow: Math.min(price.bid, price.ask),
    entryZoneHigh: Math.max(price.bid, price.ask),
    stopLoss,
    takeProfit,
    riskReward,
    reasoning: reasons.length ? reasons.join('; ') : 'Directional confluence from weighted factor scoring — see breakdown',
    marketContext: { spreadPips, evaluatedTimeframes: timeframes },
    scoreDetail,
    minSignalScore: MIN_SIGNAL_SCORE,
  };
}

/**
 * Evaluate one pair on one exchange across its configured timeframes and
 * return a signal (or a NO_TRADE result with the reasoning for why nothing fired).
 * Live path only — fetches current price + candles, then defers to the pure
 * evaluateFromData() for the actual scoring.
 */
async function evaluatePair(exchangeName, pair, timeframes) {
  const price = await exchange.getPrice(exchangeName, pair);
  const spreadPips = ((price.ask - price.bid) / price.bid) * 10000;

  const perTf = {};
  for (const tf of timeframes) {
    const candles = await exchange.getCandles(exchangeName, pair, tf, 200);
    perTf[tf] = buildTfData(candles);
  }

  return evaluateFromData({
    exchangeName, pair, timeframes, perTf, price, spreadPips,
  });
}

function scoreConfluence(perTf, timeframes) {
  let bullPoints = 0;
  let bearPoints = 0;
  const reasons = [];
  const factors = []; // raw (pre-normalization) — normalized below once maxPossible is known

  for (const tf of timeframes) {
    const { trend, breakout, momentum } = perTf[tf];
    const weight = tf === timeframes[0] ? 1.5 : 1; // entry TF weighted higher

    if (trend.trend === 'UPTREND') {
      const points = 20 * weight;
      bullPoints += points; reasons.push(`${tf} uptrend`);
      factors.push({
        timeframe: tf, label: 'uptrend (structure: higher highs + higher lows)', points, side: 'bull',
      });
    }
    if (trend.trend === 'DOWNTREND') {
      const points = 20 * weight;
      bearPoints += points; reasons.push(`${tf} downtrend`);
      factors.push({
        timeframe: tf, label: 'downtrend (structure: lower highs + lower lows)', points, side: 'bear',
      });
    }

    if (breakout?.type === 'BREAKOUT_UP') {
      const points = 15 * weight;
      bullPoints += points; reasons.push(`${tf} breakout up @ ${breakout.level.toFixed(5)}`);
      factors.push({
        timeframe: tf, label: `breakout up @ ${breakout.level.toFixed(5)} (${breakout.touches} touches)`, points, side: 'bull',
      });
    }
    if (breakout?.type === 'BREAKOUT_DOWN') {
      const points = 15 * weight;
      bearPoints += points; reasons.push(`${tf} breakout down @ ${breakout.level.toFixed(5)}`);
      factors.push({
        timeframe: tf, label: `breakout down @ ${breakout.level.toFixed(5)} (${breakout.touches} touches)`, points, side: 'bear',
      });
    }

    if (momentum.direction === 'UP') {
      const points = 10 * weight;
      bullPoints += points; reasons.push(`${tf} momentum up`);
      factors.push({ timeframe: tf, label: `momentum up (${momentum.strength.toFixed(5)} over 10 candles)`, points, side: 'bull' });
    }
    if (momentum.direction === 'DOWN') {
      const points = 10 * weight;
      bearPoints += points; reasons.push(`${tf} momentum down`);
      factors.push({ timeframe: tf, label: `momentum down (${momentum.strength.toFixed(5)} over 10 candles)`, points, side: 'bear' });
    }
  }

  const maxPossible = timeframes.reduce((sum, tf) => sum + (tf === timeframes[0] ? 45 * 1.5 : 45), 0);
  const bullScore = Math.round((bullPoints / maxPossible) * 100);
  const bearScore = Math.round((bearPoints / maxPossible) * 100);

  // Normalize every factor's contribution to the same 0-100 scale as
  // bullScore/bearScore, so "sum of the bull factors shown" always equals
  // the bull confidence % displayed — no more raw-points-vs-percentage
  // mismatch. Rounded to 1 decimal for readability; the sum can be off by
  // <=0.1 per factor from rounding, not from a unit mismatch.
  const normalizedFactors = factors.map((f) => ({
    ...f,
    pct: Math.round(((f.points / maxPossible) * 100) * 10) / 10,
  }));

  // Flag disagreeing trend direction across timeframes — e.g. entry TF
  // uptrend while a higher TF is in downtrend — so it's visible even when
  // the weighted score still favors one side overall.
  const conflicts = [];
  const trendsByTf = timeframes
    .map((tf) => ({ tf, trend: perTf[tf].trend.trend }))
    .filter((t) => t.trend === 'UPTREND' || t.trend === 'DOWNTREND');
  for (let i = 0; i < trendsByTf.length; i += 1) {
    for (let j = i + 1; j < trendsByTf.length; j += 1) {
      if (trendsByTf[i].trend !== trendsByTf[j].trend) {
        conflicts.push(`${trendsByTf[i].tf} ${trendsByTf[i].trend.toLowerCase()} vs ${trendsByTf[j].tf} ${trendsByTf[j].trend.toLowerCase()}`);
      }
    }
  }

  const scoreDetail = {
    bullScore, bearScore, maxPossible, factors: normalizedFactors, conflicts,
  };

  if (bullScore > bearScore && bullScore >= 0) return { score: bullScore, direction: 'BUY', reasons, scoreDetail };
  if (bearScore > bullScore && bearScore >= 0) return { score: bearScore, direction: 'SELL', reasons, scoreDetail };
  return {
    score: 0, direction: 'NONE', reasons: ['No clear directional confluence'], scoreDetail,
  };
}

function buildSlTp(entryTfData, direction, price) {
  const { atr } = entryTfData.volatility;
  const entry = direction === 'BUY' ? price.ask : price.bid;
  const stopDistance = atr * 1.5; // ATR-based SL
  const stopLoss = direction === 'BUY' ? entry - stopDistance : entry + stopDistance;

  // structure-based TP: nearest opposing S/R zone, fallback to 2x SL distance
  const zones = direction === 'BUY' ? entryTfData.sr.resistance : entryTfData.sr.support;
  const structural = zones
    .map((z) => z.price)
    .filter((p) => (direction === 'BUY' ? p > entry : p < entry))
    .sort((a, b) => (direction === 'BUY' ? a - b : b - a))[0];

  const takeProfit = structural ?? (direction === 'BUY' ? entry + stopDistance * 2 : entry - stopDistance * 2);
  const riskReward = Math.abs(takeProfit - entry) / Math.abs(entry - stopLoss);

  return { stopLoss, takeProfit, riskReward };
}

function noTrade(exchangeName, pair, reason, scoreDetail = null, score = 0) {
  logger.info(`NO_TRADE ${exchangeName}:${pair}: ${reason}`);
  return {
    exchange: exchangeName,
    pair,
    direction: 'NO_TRADE',
    confidence: score,
    reasoning: reason,
    scoreDetail,
    minSignalScore: MIN_SIGNAL_SCORE,
  };
}

module.exports = {
  evaluatePair, evaluateFromData, buildTfData, MIN_SIGNAL_SCORE, MIN_RR, SPREAD_LIMIT_PIPS,
};
