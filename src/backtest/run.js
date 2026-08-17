const exchange = require('../services/exchange');
const signalEngine = require('../engine/signalEngine');

const DEFAULT_EXCHANGE = process.env.BACKTEST_EXCHANGE || 'binance';
const DEFAULT_PAIR = process.env.BACKTEST_PAIR || 'BTC/USDT';
const DEFAULT_TIMEFRAMES = (process.env.TIMEFRAMES || '15m,1h').split(',').map((s) => s.trim()).filter(Boolean);
const CANDLE_COUNT = Math.max(100, Number(process.env.BACKTEST_CANDLES || 500));
const WARMUP = Math.max(30, Number(process.env.BACKTEST_WARMUP || 200));
const STEP = Math.max(1, Number(process.env.BACKTEST_STEP || 1));

function usage() {
  console.log(`\nSunnex signal-engine backtest (NO TRADES)\n\nUsage:\n  node src/backtest/run.js [exchange] [pair] [timeframes] [bars]\n\nExample:\n  node src/backtest/run.js binance BTC/USDT 15m,1h 500\n\nEnv overrides:\n  BACKTEST_EXCHANGE, BACKTEST_PAIR, BACKTEST_CANDLES, BACKTEST_WARMUP, BACKTEST_STEP\n`);
}

function iso(ms) {
  return ms ? new Date(ms).toISOString() : 'n/a';
}

function fmtSignal(s) {
  const side = s.direction === 'BUY' ? '🟢 BUY' : s.direction === 'SELL' ? '🔴 SELL' : '⚪ NO_TRADE';
  const detail = s.scoreDetail;
  return `${side} ${s.pair} score=${s.confidence}% bull=${detail?.bullScore ?? '?'} bear=${detail?.bearScore ?? '?'} R:R=${s.riskReward?.toFixed?.(2) ?? 'n/a'} | ${s.reasoning}`;
}

async function runBacktest({ exchangeName = DEFAULT_EXCHANGE, pair = DEFAULT_PAIR, timeframes = DEFAULT_TIMEFRAMES, bars = CANDLE_COUNT } = {}) {
  console.log(`\nBACKTEST MODE — historical candles only; real trading is impossible here.`);
  bars = Math.max(100, Number(bars || CANDLE_COUNT));
  console.log(`Exchange: ${exchangeName} | Pair: ${pair} | TFs: ${timeframes.join(', ')} | Bars: ${bars}`);
  console.log(`Threshold: >=${process.env.MIN_SIGNAL_SCORE || 70} | Minimum R:R: >=${process.env.MIN_RR || 1.5}\n`);

  const datasets = {};
  for (const tf of timeframes) {
    datasets[tf] = await exchange.getCandles(exchangeName, pair, tf, bars);
    console.log(`${tf}: ${datasets[tf].length} candles (${iso(datasets[tf][0]?.time)} -> ${iso(datasets[tf].at(-1)?.time)})`);
  }

  const entry = datasets[timeframes[0]];
  const signals = [];
  let evaluations = 0;
  let buy70 = 0;
  let sell70 = 0;
  let noTradeScore = 0;
  let rrBlocked = 0;
  let directionBlocked = 0;

  const start = Math.max(WARMUP, 30);
  for (let i = start; i < entry.length; i += STEP) {
    const now = entry[i].time;
    const candlesByTf = {};
    let ready = true;
    for (const tf of timeframes) {
      const all = datasets[tf];
      const end = all.findIndex((c) => c.time > now);
      const idx = end === -1 ? all.length : end;
      const window = all.slice(Math.max(0, idx - 200), idx);
      if (window.length < 30) { ready = false; break; }
      candlesByTf[tf] = window;
    }
    if (!ready) continue;

    const signal = signalEngine.evaluateHistorical({ pair, timeframes, candlesByTf });
    evaluations += 1;
    if (signal.direction === 'BUY' && signal.confidence >= 70) buy70 += 1;
    if (signal.direction === 'SELL' && signal.confidence >= 70) sell70 += 1;
    if (signal.direction === 'NO_TRADE') {
      noTradeScore += 1;
      if (/R:R/.test(signal.reasoning)) rrBlocked += 1;
      if (/No directional|below minimum/.test(signal.reasoning)) directionBlocked += 1;
    } else {
      signals.push({ time: now, signal });
    }
  }

  console.log(`\nEvaluations: ${evaluations}`);
  console.log(`>=70 BUY:  ${buy70}`);
  console.log(`>=70 SELL: ${sell70}`);
  console.log(`NO_TRADE:  ${noTradeScore} (R:R blocked: ${rrBlocked}, direction/score blocked: ${directionBlocked})`);

  if (signals.length) {
    console.log('\nFirst qualifying/near-qualifying signals:');
    signals.slice(-10).forEach(({ time, signal }) => console.log(`${iso(time)} — ${fmtSignal(signal)}`));
  } else {
    console.log('\nNo tradeable signals were produced in this sample.');
    // Print the most recent snapshot with the exact blocker so a missing signal is actionable.
    const now = entry.at(-1).time;
    const candlesByTf = {};
    for (const tf of timeframes) {
      const all = datasets[tf];
      const end = all.findIndex((c) => c.time > now);
      const idx = end === -1 ? all.length : end;
      candlesByTf[tf] = all.slice(Math.max(0, idx - 200), idx);
    }
    console.log(`Latest snapshot: ${fmtSignal(signalEngine.evaluateHistorical({ pair, timeframes, candlesByTf }))}`);
  }
  return { evaluations, buy70, sell70, signals };
}

module.exports = { runBacktest, usage };

if (require.main === module) {
  const [exchangeName = DEFAULT_EXCHANGE, pair = DEFAULT_PAIR, tfArg = DEFAULT_TIMEFRAMES.join(','), barsArg] = process.argv.slice(2);
  if (['-h', '--help'].includes(exchangeName)) { usage(); process.exit(0); }
  runBacktest({
    exchangeName,
    pair,
    timeframes: tfArg.split(',').map((s) => s.trim()).filter(Boolean),
    bars: Number(barsArg || CANDLE_COUNT),
  }).catch((err) => {
    console.error(`Backtest failed: ${err.message}`);
    process.exitCode = 1;
  });
}
