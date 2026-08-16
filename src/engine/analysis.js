/**
 * Pure price-action analysis. Takes candle arrays, returns structural facts.
 * No I/O here — keep this testable/backtestable in isolation.
 */

function findSwingPoints(candles, lookback = 3) {
  const highs = [];
  const lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const slice = candles.slice(i - lookback, i + lookback + 1);
    const c = candles[i];
    if (c.high === Math.max(...slice.map((x) => x.high))) highs.push({ index: i, price: c.high, time: c.time });
    if (c.low === Math.min(...slice.map((x) => x.low))) lows.push({ index: i, price: c.low, time: c.time });
  }
  return { highs, lows };
}

function detectTrend(candles) {
  const { highs, lows } = findSwingPoints(candles);
  if (highs.length < 2 || lows.length < 2) return { trend: 'RANGE', structure: [] };

  const lastTwoHighs = highs.slice(-2);
  const lastTwoLows = lows.slice(-2);

  const higherHigh = lastTwoHighs[1].price > lastTwoHighs[0].price;
  const higherLow = lastTwoLows[1].price > lastTwoLows[0].price;
  const lowerHigh = lastTwoHighs[1].price < lastTwoHighs[0].price;
  const lowerLow = lastTwoLows[1].price < lastTwoLows[0].price;

  let trend = 'RANGE';
  if (higherHigh && higherLow) trend = 'UPTREND';
  else if (lowerHigh && lowerLow) trend = 'DOWNTREND';

  return {
    trend,
    lastHigh: lastTwoHighs[1],
    lastLow: lastTwoLows[1],
    structure: { higherHigh, higherLow, lowerHigh, lowerLow },
  };
}

// Fixed-percentage tolerance doesn't generalize across assets: forex pairs
// chop in a ~0.05-0.1% band while crypto routinely swings several percent
// intraday, so a single hardcoded number either fragments crypto zones into
// noise or merges everything on forex. Deriving tolerance from ATR keeps the
// clustering asset- and timeframe-agnostic — it scales with how much the
// instrument actually moves.
function adaptiveTolerance(candles, atrMultiplier = 0.5, floorPct = 0.0005) {
  const { atr } = calcVolatility(candles);
  const lastClose = candles[candles.length - 1].close;
  const atrPct = atr / lastClose;
  return Math.max(atrPct * atrMultiplier, floorPct);
}

function findSupportResistance(candles, tolerance = null) {
  const effectiveTolerance = tolerance ?? adaptiveTolerance(candles);
  const { highs, lows } = findSwingPoints(candles);
  const cluster = (points) => {
    const zones = [];
    for (const p of points) {
      const existing = zones.find((z) => Math.abs(z.price - p.price) / p.price < effectiveTolerance);
      if (existing) {
        existing.touches += 1;
        existing.price = (existing.price + p.price) / 2;
      } else {
        zones.push({ price: p.price, touches: 1 });
      }
    }
    return zones.filter((z) => z.touches >= 2).sort((a, b) => b.touches - a.touches);
  };
  return { resistance: cluster(highs), support: cluster(lows), toleranceUsed: effectiveTolerance };
}

function detectBreakout(candles, srZones) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  for (const zone of srZones.resistance) {
    if (prev.close <= zone.price && last.close > zone.price) {
      return { type: 'BREAKOUT_UP', level: zone.price, touches: zone.touches };
    }
  }
  for (const zone of srZones.support) {
    if (prev.close >= zone.price && last.close < zone.price) {
      return { type: 'BREAKOUT_DOWN', level: zone.price, touches: zone.touches };
    }
  }
  return null;
}

function detectRetest(candles, level, direction, withinBars = 5) {
  const recent = candles.slice(-withinBars);
  const tolerance = level * adaptiveTolerance(candles, 0.35); // tighter than S/R clustering — a retest should be close
  return recent.some((c) => Math.abs(c.low - level) < tolerance || Math.abs(c.high - level) < tolerance)
    && (direction === 'up' ? recent[recent.length - 1].close > level : recent[recent.length - 1].close < level);
}

function calcVolatility(candles, period = 14) {
  const recent = candles.slice(-period);
  const ranges = recent.map((c) => c.high - c.low);
  const atr = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  return { atr, atrPips: atr * 10000 };
}

function calcMomentum(candles, period = 10) {
  const recent = candles.slice(-period);
  const closeChange = recent[recent.length - 1].close - recent[0].close;
  const avgBody = recent.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0) / recent.length;
  return { direction: closeChange > 0 ? 'UP' : 'DOWN', strength: Math.abs(closeChange), avgBody };
}

module.exports = {
  findSwingPoints,
  detectTrend,
  findSupportResistance,
  detectBreakout,
  detectRetest,
  calcVolatility,
  calcMomentum,
  adaptiveTolerance,
};
