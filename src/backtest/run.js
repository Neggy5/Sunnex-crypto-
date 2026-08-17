require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { runBacktest } = require('./engine');
const { formatScanBlock } = require('../bot/format');
const logger = require('../utils/logger');

// Backtest-specific env, each falling back to the live scanner's env vars,
// then to a hardcoded default — so you can point this at the exact same
// universe the live bot scans just by running `npm run backtest`, or
// override just the backtest side (e.g. widen history) without touching
// the live config.
const EXCHANGES = (process.env.BACKTEST_EXCHANGES || process.env.EXCHANGES || 'binance,bybit')
  .split(',').map((s) => s.trim());
// Widened default pair list vs. before — more pairs means more independent
// samples per unit of history pulled, and spreads exposure across assets
// that aren't all in the same regime at the same time.
const PAIRS = (process.env.BACKTEST_PAIRS || process.env.PAIRS
  || 'BTC/USDT,ETH/USDT,SOL/USDT,BNB/USDT,XRP/USDT,ADA/USDT,DOGE/USDT,AVAX/USDT')
  .split(',').map((s) => s.trim());
const TIMEFRAMES = (process.env.BACKTEST_TIMEFRAMES || process.env.TIMEFRAMES || '15m,1h')
  .split(',').map((s) => s.trim());

// Starting candle count per timeframe. If the run doesn't clear
// MIN_QUALIFYING_TRADES, main() below re-fetches with more history and
// tries again, up to MAX_CANDLES. 3000 x 15m candles ≈ 31 days as a
// starting point — exchange.js paginates automatically past ~1000 candles.
const STARTING_CANDLES = Number(process.env.BACKTEST_CANDLES || 3000);
const MAX_CANDLES = Number(process.env.BACKTEST_MAX_CANDLES || 20000); // ≈ 208 days of 15m candles
const MIN_QUALIFYING_TRADES = Number(process.env.BACKTEST_MIN_QUALIFYING || 100);
// How much to grow history by each time the sample is still too small.
const GROWTH_FACTOR = 1.6;

// Matches the live engine's lookback window (src/engine/signalEngine.js
// calls exchange.getCandles(..., 200)) so trend/S-R/momentum are computed
// over the same amount of history at every step.
const WINDOW = Number(process.env.BACKTEST_WINDOW || 200);
// Confidence bar used to pick "qualifying" signals for the report.
// Deliberately independent of the live MIN_SIGNAL_SCORE env var (which may
// itself be misconfigured) — this always shows genuine >=70 examples.
const REPORT_MIN_SCORE = Number(process.env.BACKTEST_MIN_SCORE || 70);
// See engine.js backtestPair() for why this exists: historical bid/ask
// spread data doesn't exist for a single OHLCV feed, so this is a
// stand-in that still exercises the live SPREAD_LIMIT_PIPS filter path.
const ASSUMED_SPREAD_PIPS = Number(process.env.BACKTEST_ASSUMED_SPREAD_PIPS || 0);
// Per-side fee and slippage assumptions, as a percent of trade price.
// Binance/Bybit spot taker fees are typically ~0.1% per side; 0.05%
// slippage per side is a reasonable conservative default for liquid pairs
// at modest size. Override for your actual fee tier / typical size.
const FEE_PCT_PER_SIDE = Number(process.env.BACKTEST_FEE_PCT_PER_SIDE ?? 0.1);
const SLIPPAGE_PCT_PER_SIDE = Number(process.env.BACKTEST_SLIPPAGE_PCT_PER_SIDE ?? 0.05);
const MAX_EXAMPLES_PER_DIRECTION = Number(process.env.BACKTEST_MAX_EXAMPLES || 3);
const OUTPUT_PATH = process.env.BACKTEST_OUTPUT || path.join(__dirname, '../../data/backtest-results.json');

function qualifyingCount(summary) {
  return summary.qualifyingBuy.length + summary.qualifyingSell.length;
}

async function main() {
  logger.info(`Backtest starting — exchanges: ${EXCHANGES.join(', ')} | pairs: ${PAIRS.join(', ')} | timeframes: ${TIMEFRAMES.join(', ')}`);
  logger.info(`Target: >=${MIN_QUALIFYING_TRADES} qualifying trades, growing history from ${STARTING_CANDLES} up to ${MAX_CANDLES} candles/tf if needed.`);
  logger.info(`Window: ${WINDOW} | report threshold: >=${REPORT_MIN_SCORE} | fees: ${FEE_PCT_PER_SIDE}%/side | slippage: ${SLIPPAGE_PCT_PER_SIDE}%/side`);
  logger.info('Read-only: no Telegram messages, no MT5/exchange orders, no DB writes.');

  let candles = STARTING_CANDLES;
  let run;

  // Re-fetches the FULL history each iteration (simplest correct approach —
  // no incremental caching), so a large run can mean several rounds of
  // exchange API calls. That's expected; it's still read-only market data
  // and respects ccxt's built-in rate limiting, but expect this to take a
  // while for a big MIN_QUALIFYING_TRADES target. This loop is CLI-only —
  // the Telegram /backtest command stays single-shot to avoid a stalled
  // webhook reply.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    logger.info(`Running with ${candles} candles/timeframe...`);
    // eslint-disable-next-line no-await-in-loop
    run = await runBacktest({
      exchanges: EXCHANGES,
      pairs: PAIRS,
      timeframes: TIMEFRAMES,
      historyCandles: candles,
      window: WINDOW,
      reportMinScore: REPORT_MIN_SCORE,
      assumedSpreadPips: ASSUMED_SPREAD_PIPS,
      feePctPerSide: FEE_PCT_PER_SIDE,
      slippagePctPerSide: SLIPPAGE_PCT_PER_SIDE,
    });

    const count = qualifyingCount(run.summary);
    logger.info(`-> ${count} qualifying signal(s) at >=${REPORT_MIN_SCORE} confidence.`);

    if (count >= MIN_QUALIFYING_TRADES) break;
    if (candles >= MAX_CANDLES) {
      logger.info(`Hit MAX_CANDLES (${MAX_CANDLES}) without reaching ${MIN_QUALIFYING_TRADES} qualifying trades — reporting what we have.`);
      break;
    }
    candles = Math.min(MAX_CANDLES, Math.round(candles * GROWTH_FACTOR));
  }

  const { allResults, summary } = run;

  const fmtStats = (s) => [
    `  Total closed trades: ${s.totalTrades}  (still OPEN at end of history: ${s.openTrades})`,
    `  Wins / Losses: ${s.wins} / ${s.losses}`,
    `  Win rate: ${s.winRate === null ? 'n/a' : `${s.winRate.toFixed(1)}%`}`,
    `  Total P/L (net of fees/slippage): ${s.totalPL === null ? 'n/a' : `${s.totalPL >= 0 ? '+' : ''}${s.totalPL.toFixed(2)}R`}`,
    `  Profit factor: ${s.profitFactor === null ? 'n/a' : (s.profitFactor === Infinity ? '∞ (no losses)' : s.profitFactor.toFixed(2))}`,
    `  Average win: ${s.avgWin === null ? 'n/a' : `+${s.avgWin.toFixed(2)}R`}   Average loss: ${s.avgLoss === null ? 'n/a' : `${s.avgLoss.toFixed(2)}R`}`,
    `  Average R:R (planned): ${s.avgRR === null ? 'n/a' : s.avgRR.toFixed(2)}`,
    `  Max drawdown: ${s.maxDrawdown.toFixed(2)}R`,
  ].join('\n');

  console.log('\n=========== BACKTEST SUMMARY ===========');
  console.log(`History used: ${run.config.historyCandles} candles/timeframe across ${PAIRS.length} pairs on ${EXCHANGES.join(', ')}`);
  console.log(`Total signals fired (any confidence): ${summary.totalSignals}  (BUY ${summary.buyCount} / SELL ${summary.sellCount})`);
  console.log(`Qualifying at >=${REPORT_MIN_SCORE}: ${qualifyingCount(summary)}  (BUY ${summary.qualifyingBuy.length} / SELL ${summary.qualifyingSell.length})`);
  if (qualifyingCount(summary) < MIN_QUALIFYING_TRADES) {
    console.log(`⚠️  Did not reach the ${MIN_QUALIFYING_TRADES}-trade target even at the ${MAX_CANDLES}-candle cap.`);
    console.log('   Raise BACKTEST_MAX_CANDLES, add more pairs via BACKTEST_PAIRS, or lower BACKTEST_MIN_SCORE.');
  }
  console.log('\n--- Stats: ALL signals (any confidence) ---');
  console.log(fmtStats(summary.statsAll));
  console.log(`\n--- Stats: QUALIFYING signals only (>=${REPORT_MIN_SCORE}) ---`);
  console.log(fmtStats(summary.statsQualifying));

  console.log('\n--- Stats by confidence band (qualifying set) ---');
  summary.statsByConfidenceBand.forEach((band) => {
    console.log(`\n[${band.label}]  (${band.totalTrades} closed, ${band.openTrades} open)`);
    if (band.totalTrades === 0) {
      console.log('  No closed trades in this band.');
      return;
    }
    console.log(`  Win rate: ${band.winRate.toFixed(1)}%   Total P/L: ${band.totalPL >= 0 ? '+' : ''}${band.totalPL.toFixed(2)}R   `
      + `Profit factor: ${band.profitFactor === null ? 'n/a' : (band.profitFactor === Infinity ? '∞' : band.profitFactor.toFixed(2))}   `
      + `Max DD: ${band.maxDrawdown.toFixed(2)}R`);
  });

  console.log('\nP/L, drawdown, and profit factor are in R-multiples (multiples of risk), not pips —');
  console.log('deliberately asset-agnostic so crypto and forex pairs are comparable. Figures are NET');
  console.log(`of a modeled ${FEE_PCT_PER_SIDE}% fee + ${SLIPPAGE_PCT_PER_SIDE}% slippage per side (round trip cost `
    + `converted to R via each trade's own stop distance).`);
  console.log('=========================================\n');

  console.log('--- Individual signal outcomes (qualifying set, chronological) ---\n');
  summary.statsQualifying.trades.forEach((t) => {
    const outcomeTag = t.outcome === 'TP' ? '✅ TP HIT' : (t.outcome === 'SL' ? '❌ SL HIT' : '⏳ OPEN (ran out of history)');
    const pnl = t.pnlR === null ? '' : `  |  Net P/L: ${t.pnlR >= 0 ? '+' : ''}${t.pnlR.toFixed(2)}R (gross ${t.pnlRGross >= 0 ? '+' : ''}${t.pnlRGross.toFixed(2)}R, cost ${t.costR.toFixed(2)}R)`;
    const ambiguousTag = t.outcomeAmbiguous ? '  [TP & SL both touched same candle — assumed SL first]' : '';
    console.log(`[${t.backtestTime}] ${t.direction} ${t.pair} (${t.exchange}) conf=${t.confidence}% R:R=${t.riskReward.toFixed(2)} -> ${outcomeTag}${pnl}  (${t.barsHeld} bars)${ambiguousTag}`);
  });
  console.log('');

  if (!summary.qualifyingBuy.length && !summary.qualifyingSell.length) {
    console.log(`No signal in this history cleared >=${REPORT_MIN_SCORE} confidence in either direction.`);
    console.log('This can be a legitimate result (conflicting timeframes cap the score often — see the live NO_TRADE');
    console.log('reasoning strings), not necessarily a bug. Try a wider pair/timeframe set or more history via');
    console.log('BACKTEST_PAIRS / BACKTEST_TIMEFRAMES / BACKTEST_MAX_CANDLES to get examples faster.');
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

  const statsForJson = (s) => ({
    totalTrades: s.totalTrades,
    openTrades: s.openTrades,
    wins: s.wins,
    losses: s.losses,
    winRate: s.winRate,
    totalPL: s.totalPL,
    profitFactor: s.profitFactor === Infinity ? null : s.profitFactor,
    avgWin: s.avgWin,
    avgLoss: s.avgLoss,
    avgRR: s.avgRR,
    maxDrawdown: s.maxDrawdown,
  });

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({
    config: {
      exchanges: EXCHANGES,
      pairs: PAIRS,
      timeframes: TIMEFRAMES,
      historyCandlesUsed: run.config.historyCandles,
      window: WINDOW,
      reportMinScore: REPORT_MIN_SCORE,
      assumedSpreadPips: ASSUMED_SPREAD_PIPS,
      feePctPerSide: FEE_PCT_PER_SIDE,
      slippagePctPerSide: SLIPPAGE_PCT_PER_SIDE,
    },
    summary: {
      totalSignals: summary.totalSignals, buyCount: summary.buyCount, sellCount: summary.sellCount,
    },
    statsAll: statsForJson(summary.statsAll),
    statsQualifying: statsForJson(summary.statsQualifying),
    statsByConfidenceBand: summary.statsByConfidenceBand.map((b) => ({ label: b.label, ...statsForJson(b) })),
    allSignals: allResults, // each entry includes outcome, exitTime, barsHeld, pnlRGross, costR, pnlR
  }, null, 2));
  logger.info(`Full results written to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  logger.error(`Fatal backtest error: ${err.message}`);
  process.exit(1);
});
