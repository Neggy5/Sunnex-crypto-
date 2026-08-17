const ccxt = require('ccxt');
const logger = require('../utils/logger');

// Public market data (prices, candles) needs no API key on either exchange.
// Keys are only required later for order placement (auto-trading phase).
const clients = {};

function getClient(exchangeName) {
  if (clients[exchangeName]) return clients[exchangeName];

  const ExchangeClass = ccxt[exchangeName];
  if (!ExchangeClass) throw new Error(`Unsupported exchange: ${exchangeName}`);

  const client = new ExchangeClass({
    apiKey: process.env[`${exchangeName.toUpperCase()}_API_KEY`] || undefined,
    secret: process.env[`${exchangeName.toUpperCase()}_API_SECRET`] || undefined,
    enableRateLimit: true,
  });

  clients[exchangeName] = client;
  return client;
}

const marketsLoaded = {};
async function ensureMarketsLoaded(client, exchangeName) {
  if (marketsLoaded[exchangeName]) return;
  await client.loadMarkets();
  marketsLoaded[exchangeName] = true;
}

// ccxt timeframe strings: '1m','5m','15m','1h','4h','1d' — map our M15/H1/H4 style if needed
const TF_MAP = {
  M1: '1m', M5: '5m', M15: '15m', M30: '30m', H1: '1h', H4: '4h', D1: '1d',
};

function normalizeTf(tf) {
  const key = String(tf).trim().toUpperCase();
  return TF_MAP[key] || String(tf).trim().toLowerCase(); // case-insensitive match, else pass through lowercased (ccxt format, e.g. "15m")
}

async function getPrice(exchangeName, pair) {
  try {
    const client = getClient(exchangeName);
    await ensureMarketsLoaded(client, exchangeName);
    const ticker = await client.fetchTicker(pair);
    return { bid: ticker.bid, ask: ticker.ask, timestamp: ticker.timestamp };
  } catch (err) {
    logger.error(`exchange.getPrice(${exchangeName}, ${pair}) failed: ${err.message}`);
    throw err;
  }
}

function mapCandles(ohlcv) {
  return ohlcv.map(([time, open, high, low, close, volume]) => ({
    time, open, high, low, close, volume,
  }));
}

// ms per candle, used to paginate backward far enough for large historical
// pulls. Only the timeframes this bot uses need entries here.
const TF_MS = {
  '1m': 60000,
  '5m': 300000,
  '15m': 900000,
  '30m': 1800000,
  '1h': 3600000,
  '4h': 14400000,
  '1d': 86400000,
};

// Most exchanges cap a single fetchOHLCV call around 1000-1500 candles, so
// pulling months of history (backtest) needs multiple paginated calls
// walking forward in time from `since`. The live scanner's normal calls
// (count=200) stay on the single-call fast path below — this only kicks in
// for the larger counts a backtest asks for.
const PAGINATION_THRESHOLD = 1000;
const PAGE_SIZE = 1000;

async function fetchPaginated(client, pair, tf, count) {
  const msPerCandle = TF_MS[tf];
  if (!msPerCandle) {
    // Unknown timeframe string — fall back to whatever the exchange gives
    // us in one call rather than guessing at ms-per-candle math.
    const ohlcv = await client.fetchOHLCV(pair, tf, undefined, count);
    return mapCandles(ohlcv);
  }

  let since = Date.now() - count * msPerCandle;
  let all = [];

  while (all.length < count) {
    // eslint-disable-next-line no-await-in-loop
    const batch = await client.fetchOHLCV(pair, tf, since, PAGE_SIZE);
    if (!batch.length) break;

    all = all.concat(batch);
    const lastTime = batch[batch.length - 1][0];
    if (lastTime < since) break; // no forward progress — avoid an infinite loop
    since = lastTime + msPerCandle;
    if (batch.length < PAGE_SIZE) break; // exchange ran out of history (caught up to "now")
  }

  return mapCandles(all).slice(-count);
}

async function getCandles(exchangeName, pair, timeframe, count = 200) {
  try {
    const client = getClient(exchangeName);
    await ensureMarketsLoaded(client, exchangeName);
    const tf = normalizeTf(timeframe);

    if (count <= PAGINATION_THRESHOLD) {
      const ohlcv = await client.fetchOHLCV(pair, tf, undefined, count);
      return mapCandles(ohlcv);
    }

    return await fetchPaginated(client, pair, tf, count);
  } catch (err) {
    logger.error(`exchange.getCandles(${exchangeName}, ${pair}, ${timeframe}) failed: ${err.message}`);
    throw err;
  }
}

async function isConnected(exchangeName) {
  try {
    const client = getClient(exchangeName);
    await client.fetchTime();
    return true;
  } catch {
    return false;
  }
}

module.exports = { getPrice, getCandles, isConnected };
