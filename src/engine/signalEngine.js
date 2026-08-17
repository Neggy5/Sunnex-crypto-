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
 * Evaluate one pair on one exchange across its configured timeframes and
 * return a signal (or a NO_TRADE result with the reasoning for why nothing fired).
 */
async function evaluatePair(exchangeName, pair, timeframes) {
  const price = await exchange.getPrice(exchangeName, pair);
  const candlesByTf = {};
  for (const tf of timeframes) {
    candlesByTf[tf] = await exchange.getCandles(exchangeName, pair, tf, 200);
  }
  return evaluateFromCandles({ exchangeName, pair, timeframes, candlesByTf, price });
}

/**
 * Evaluate a signal using supplied candles instead of live market data.
 * This is deliberately separate from order execution: it can never place a trade.
 */
function evaluateFromCandles({
  exchangeName = 'backtest',
  pair,
  timeframes,
  candlesByTf,
  price,
  skipSpreadCheck = false,
}) {
  if (!pair) throw new Error('pair is required');
  if (!Array.isArray(timeframes) || !timeframes.length) throw new Error('timeframes are required');

  const safePrice = price || (() => {
    const c = candlesByTf?.[timeframes[0]]?.at(-1);
    if (!c) throw new Error(`No candles supplied for ${timeframes[0]}`);
    return { bid: c.close, ask: c.close, timestamp: c.time };
  })();

  const spreadPips = safePrice.bid ? ((safePrice.ask - safePrice.bid) / safePrice.bid) * 10000 : 0;
  if (!skipSpreadCheck && spreadPips > SPREAD_LIMIT_PIPS) {
    return noTrade(exchangeName, pair, `Spread too wide (${spreadPips.toFixed(1)} pips > ${SPREAD_LIMIT_PIPS})`, null, 0);
  }

  const perTf = {};
  for (const tf of timeframes) {
    const candles = candlesByTf?.[tf];
    if (!Array.isArray(candles) || candles.length < 30) {
      return noTrade(exchangeName, pair, `${tf}: not enough candles (${candles?.length || 0}; need at least 30)`);
    }
    const trend = analysis.detectTrend(candles);
    const sr = analysis.findSupportResistance(candles);
    const breakout = analysis.detectBreakout(candles, sr);
    const volatility = analysis.calcVolatility(candles);
    const momentum = analysis.calcMomentum(candles);
    perTf[tf] = { trend, sr, breakout, volatility, momentum, candles };
  }

  const { score, direction, reasons, scoreDetail } = scoreConfluence(perTf, timeframes);

  if (direction === 'NONE') {
    return noTrade(exchangeName, pair, reasons.join('; ') || 'No directional confluence', scoreDetail, score);
  }
  if (score < MIN_SIGNAL_SCORE) {
    return noTrade(exchangeName, pair, `Score ${score} below minimum ${MIN_SIGNAL_SCORE} (${direction} candidate)`, scoreDetail, score);
  }

  const entryTf = perTf[timeframes[0]];
  const { stopLoss, takeProfit, riskReward } = buildSlTp(entryTf, direction, safePrice);

  if (!Number.isFinite(riskReward) || riskReward < MIN_RR) {
    return noTrade(exchangeName, pair, `R:R ${Number.isFinite(riskReward) ? riskReward.toFixed(2) : 'invalid'} below minimum ${MIN_RR} (${direction} score ${score})`, scoreDetail, score);
  }

  return {
    exchange: exchangeName,
    pair,
    timeframe: timeframes[0],
    direction,
    confidence: score,
    entryZoneLow: Math.min(safePrice.bid, safePrice.ask),
    entryZoneHigh: Math.max(safePrice.bid, safePrice.ask),
    stopLoss,
    takeProfit,
    riskReward,
    reasoning: reasons.length ? reasons.join('; ') : 'Directional confluence from weighted factor scoring — see breakdown',
    marketContext: { spreadPips, evaluatedTimeframes: timeframes, backtest: exchangeName === 'backtest' },
    scoreDetail,
    minSignalScore: MIN_SIGNAL_SCORE,
  };
}

/** Evaluate a historical candle snapshot. No exchange calls and no trading. */
function evaluateHistorical({ pair, timeframes, candlesByTf }) {
  const base = candlesByTf?.[timeframes[0]]?.at(-1);
  if (!base) throw new Error(`No historical ${timeframes[0]} candle supplied`);
  return evaluateFromCandles({
    exchangeName: 'backtest',
    pair,
    timeframes,
    candlesByTf,
    price: { bid: base.close, ask: base.close, timestamp: base.time },
    skipSpreadCheck: true,
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

module.exports = { evaluatePair, evaluateFromCandles, evaluateHistorical, scoreConfluence, buildSlTp };
