const signalEngine = require('./src/engine/signalEngine');

function fakeCandles(n, lastClose) {
  const candles = [];
  for (let i = 0; i < n; i += 1) {
    candles.push({
      time: 1700000000000 + i * 900000, open: lastClose, high: lastClose + 1, low: lastClose - 1, close: lastClose, volume: 100,
    });
  }
  return candles;
}

function tfData({
  trend, breakoutType, breakoutLevel, momentumDir, atr, resistance, support,
}) {
  return {
    trend: { trend, structure: {} },
    sr: { resistance: resistance || [], support: support || [], toleranceUsed: 0.001 },
    breakout: breakoutType ? { type: breakoutType, level: breakoutLevel, touches: 3 } : null,
    volatility: { atr, atrPips: atr * 10000 },
    momentum: { direction: momentumDir, strength: 2, avgBody: 1 },
    candles: fakeCandles(30, breakoutLevel || 100),
  };
}

// --- Case 1: strong BUY confluence across both timeframes ---
const buyPerTf = {
  '15m': tfData({
    trend: 'UPTREND', breakoutType: 'BREAKOUT_UP', breakoutLevel: 100, momentumDir: 'UP', atr: 1.2, resistance: [{ price: 104, touches: 3 }],
  }),
  '1h': tfData({
    trend: 'UPTREND', breakoutType: 'BREAKOUT_UP', breakoutLevel: 99, momentumDir: 'UP', atr: 1.5, resistance: [{ price: 106, touches: 2 }],
  }),
};
const buyResult = signalEngine.evaluateFromData({
  exchangeName: 'binance',
  pair: 'TEST/USDT',
  timeframes: ['15m', '1h'],
  perTf: buyPerTf,
  price: { bid: 101, ask: 101.02 },
  spreadPips: 2,
});

// --- Case 2: strong SELL confluence across both timeframes ---
const sellPerTf = {
  '15m': tfData({
    trend: 'DOWNTREND', breakoutType: 'BREAKOUT_DOWN', breakoutLevel: 100, momentumDir: 'DOWN', atr: 1.2, support: [{ price: 96, touches: 3 }],
  }),
  '1h': tfData({
    trend: 'DOWNTREND', breakoutType: 'BREAKOUT_DOWN', breakoutLevel: 101, momentumDir: 'DOWN', atr: 1.5, support: [{ price: 94, touches: 2 }],
  }),
};
const sellResult = signalEngine.evaluateFromData({
  exchangeName: 'binance',
  pair: 'TEST/USDT',
  timeframes: ['15m', '1h'],
  perTf: sellPerTf,
  price: { bid: 98.98, ask: 99 },
  spreadPips: 2,
});

// --- Case 3: NO_TRADE — conflicting timeframes, low score ---
const conflictPerTf = {
  '15m': tfData({
    trend: 'UPTREND', momentumDir: 'UP', atr: 1.2,
  }),
  '1h': tfData({
    trend: 'DOWNTREND', momentumDir: 'DOWN', atr: 1.5,
  }),
};
const noTradeResult = signalEngine.evaluateFromData({
  exchangeName: 'binance',
  pair: 'TEST/USDT',
  timeframes: ['15m', '1h'],
  perTf: conflictPerTf,
  price: { bid: 100, ask: 100.02 },
  spreadPips: 2,
});

console.log('\n=== BUY case ===');
console.log(`direction=${buyResult.direction} confidence=${buyResult.confidence}`);
if (buyResult.direction === 'BUY') {
  console.log(`entry ${buyResult.entryZoneLow}-${buyResult.entryZoneHigh}  SL=${buyResult.stopLoss.toFixed(4)}  TP=${buyResult.takeProfit.toFixed(4)}  RR=${buyResult.riskReward.toFixed(2)}`);
  console.log(`reasoning: ${buyResult.reasoning}`);
}

console.log('\n=== SELL case ===');
console.log(`direction=${sellResult.direction} confidence=${sellResult.confidence}`);
if (sellResult.direction === 'SELL') {
  console.log(`entry ${sellResult.entryZoneLow}-${sellResult.entryZoneHigh}  SL=${sellResult.stopLoss.toFixed(4)}  TP=${sellResult.takeProfit.toFixed(4)}  RR=${sellResult.riskReward.toFixed(2)}`);
  console.log(`reasoning: ${sellResult.reasoning}`);
}

console.log('\n=== NO_TRADE (conflict) case ===');
console.log(`direction=${noTradeResult.direction} confidence=${noTradeResult.confidence}`);
console.log(`reason: ${noTradeResult.reasoning}`);

console.log('\n--- assertions ---');
console.log('BUY fires with confidence >=70:', buyResult.direction === 'BUY' && buyResult.confidence >= 70);
console.log('SELL fires with confidence >=70:', sellResult.direction === 'SELL' && sellResult.confidence >= 70);
console.log('conflict case is NO_TRADE:', noTradeResult.direction === 'NO_TRADE');
