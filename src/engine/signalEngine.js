const analysis = require('./analysis');
const exchange = require('../services/exchange');
const logger = require('../utils/logger');

const MIN_SIGNAL_SCORE = Number(process.env.MIN_SIGNAL_SCORE || 70);
const MIN_RR = Number(process.env.MIN_RR || 1.5);
const SPREAD_LIMIT_PIPS = Number(process.env.SPREAD_LIMIT_PIPS || 3);

/**
 * Evaluate one pair on one exchange across its configured timeframes and
 * return a signal (or a NO_TRADE result with the reasoning for why nothing fired).
 */
async function evaluatePair(exchangeName, pair, timeframes) {
  const price = await exchange.getPrice(exchangeName, pair);
  const spreadPips = ((price.ask - price.bid) / price.bid) * 10000;

  if (spreadPips > SPREAD_LIMIT_PIPS) {
    return noTrade(exchangeName, pair, `Spread too wide (${spreadPips.toFixed(1)} pips > ${SPREAD_LIMIT_PIPS})`);
  }

  const perTf = {};
  for (const tf of timeframes) {
    const candles = await exchange.getCandles(exchangeName, pair, tf, 200);
    const trend = analysis.detectTrend(candles);
    const sr = analysis.findSupportResistance(candles);
    const breakout = analysis.detectBreakout(candles, sr);
    const volatility = analysis.calcVolatility(candles);
    const momentum = analysis.calcMomentum(candles);
    perTf[tf] = { trend, sr, breakout, volatility, momentum, candles };
  }

  const { score, direction, reasons } = scoreConfluence(perTf, timeframes);

  if (score < MIN_SIGNAL_SCORE || direction === 'NONE') {
    return noTrade(exchangeName, pair, reasons.join('; ') || 'Insufficient confluence');
  }

  const entryTf = perTf[timeframes[0]];
  const { stopLoss, takeProfit, riskReward } = buildSlTp(entryTf, direction, price);

  if (riskReward < MIN_RR) {
    return noTrade(exchangeName, pair, `R:R ${riskReward.toFixed(2)} below minimum ${MIN_RR}`);
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
    reasoning: reasons.join('; '),
    marketContext: { spreadPips, evaluatedTimeframes: timeframes },
  };
}

function scoreConfluence(perTf, timeframes) {
  let bullPoints = 0;
  let bearPoints = 0;
  const reasons = [];

  for (const tf of timeframes) {
    const { trend, breakout, momentum } = perTf[tf];
    const weight = tf === timeframes[0] ? 1.5 : 1; // entry TF weighted higher

    if (trend.trend === 'UPTREND') { bullPoints += 20 * weight; reasons.push(`${tf} uptrend`); }
    if (trend.trend === 'DOWNTREND') { bearPoints += 20 * weight; reasons.push(`${tf} downtrend`); }

    if (breakout?.type === 'BREAKOUT_UP') { bullPoints += 15 * weight; reasons.push(`${tf} breakout up @ ${breakout.level.toFixed(5)}`); }
    if (breakout?.type === 'BREAKOUT_DOWN') { bearPoints += 15 * weight; reasons.push(`${tf} breakout down @ ${breakout.level.toFixed(5)}`); }

    if (momentum.direction === 'UP') bullPoints += 10 * weight;
    if (momentum.direction === 'DOWN') bearPoints += 10 * weight;
  }

  const maxPossible = timeframes.reduce((sum, tf) => sum + (tf === timeframes[0] ? 45 * 1.5 : 45), 0);
  const bullScore = Math.round((bullPoints / maxPossible) * 100);
  const bearScore = Math.round((bearPoints / maxPossible) * 100);

  if (bullScore > bearScore && bullScore >= 0) return { score: bullScore, direction: 'BUY', reasons };
  if (bearScore > bullScore && bearScore >= 0) return { score: bearScore, direction: 'SELL', reasons };
  return { score: 0, direction: 'NONE', reasons: ['No clear directional confluence'] };
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

function noTrade(exchangeName, pair, reason) {
  logger.info(`NO_TRADE ${exchangeName}:${pair}: ${reason}`);
  return {
    exchange: exchangeName,
    pair,
    direction: 'NO_TRADE',
    confidence: 0,
    reasoning: reason,
  };
}

module.exports = { evaluatePair };
