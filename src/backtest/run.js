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

async function main() {
  logger.info(`Backtest starting — exchanges: ${EXCHANGES.join(', ')} | pairs: ${PAIRS.join(', ')} | timeframes: ${TIMEFRAMES.join(', ')}`);
  logger.info(`History: ${HISTORY_CANDLES} candles/tf | window: ${WINDOW} | report threshold: >=${REPORT_MIN_SCORE}`);
  logger.info('Read-only: no Telegram messages, no MT5/exchange orders, no DB writes.');

  const { allResults, summary } = await runBacktest({
    exchanges: EXCHANGES,
    pairs: PAIRS,
    timeframes: TIMEFRAMES,
    historyCandles: HISTORY_CANDLES,
    window: WINDOW,
    reportMinScore: REPORT_MIN_SCORE,
  });

  const fmtStats = (s) => [
    `  Total closed trades: ${s.totalTrades}  (still OPEN at end of history: ${s.openTrades})`,
    `  Wins / Losses: ${s.wins} / ${s.losses}`,
    `  Win rate: ${s.winRate === null ? 'n/a' : `${s.winRate.toFixed(1)}%`}`,
    `  Total P/L: ${s.totalPL === null ? 'n/a' : `${s.totalPL >= 0 ? '+' : ''}${s.totalPL.toFixed(2)}R`}`,
    `  Average R:R (planned): ${s.avgRR === null ? 'n/a' : s.avgRR.toFixed(2)}`,
    `  Max drawdown: ${s.maxDrawdown.toFixed(2)}R`,
  ].join('\n');

  console.log('\n=========== BACKTEST SUMMARY ===========');
  console.log(`Total signals fired (any confidence): ${summary.totalSignals}  (BUY ${summary.buyCount} / SELL ${summary.sellCount})`);
  console.log(`Qualifying at >=${REPORT_MIN_SCORE}: BUY ${summary.qualifyingBuy.length} / SELL ${summary.qualifyingSell.length}`);
  console.log('\n--- Stats: ALL signals (any confidence) ---');
  console.log(fmtStats(summary.statsAll));
  console.log(`\n--- Stats: QUALIFYING signals only (>=${REPORT_MIN_SCORE}) ---`);
  console.log(fmtStats(summary.statsQualifying));
  console.log('\nP/L and drawdown are in R-multiples (multiples of risk), not pips —');
  console.log('deliberately asset-agnostic so crypto and forex pairs are comparable.');
  console.log('=========================================\n');

  console.log('--- Individual signal outcomes (qualifying set, chronological) ---\n');
  summary.statsQualifying.trades.forEach((t) => {
    const outcomeTag = t.outcome === 'TP' ? '✅ TP HIT' : (t.outcome === 'SL' ? '❌ SL HIT' : '⏳ OPEN (ran out of history)');
    const pnl = t.pnlR === null ? '' : `  |  P/L: ${t.pnlR >= 0 ? '+' : ''}${t.pnlR.toFixed(2)}R`;
    const ambiguousTag = t.outcomeAmbiguous ? '  [TP & SL both touched same candle — assumed SL first]' : '';
    console.log(`[${t.backtestTime}] ${t.direction} ${t.pair} (${t.exchange}) conf=${t.confidence}% R:R=${t.riskReward.toFixed(2)} -> ${outcomeTag}${pnl}  (${t.barsHeld} bars)${ambiguousTag}`);
  });
  console.log('');

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
    statsAll: {
      totalTrades: summary.statsAll.totalTrades,
      openTrades: summary.statsAll.openTrades,
      wins: summary.statsAll.wins,
      losses: summary.statsAll.losses,
      winRate: summary.statsAll.winRate,
      totalPL: summary.statsAll.totalPL,
      avgRR: summary.statsAll.avgRR,
      maxDrawdown: summary.statsAll.maxDrawdown,
    },
    statsQualifying: {
      totalTrades: summary.statsQualifying.totalTrades,
      openTrades: summary.statsQualifying.openTrades,
      wins: summary.statsQualifying.wins,
      losses: summary.statsQualifying.losses,
      winRate: summary.statsQualifying.winRate,
      totalPL: summary.statsQualifying.totalPL,
      avgRR: summary.statsQualifying.avgRR,
      maxDrawdown: summary.statsQualifying.maxDrawdown,
    },
    allSignals: allResults, // each entry now includes outcome, exitTime, barsHeld, pnlR
  }, null, 2));
  logger.info(`Full results written to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  logger.error(`Fatal backtest error: ${err.message}`);
  process.exit(1);
});
