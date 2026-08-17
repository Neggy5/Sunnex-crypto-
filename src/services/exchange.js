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

async function getCandles(exchangeName, pair, timeframe, count = 200) {
  try {
    const client = getClient(exchangeName);
    await ensureMarketsLoaded(client, exchangeName);
    const ohlcv = await client.fetchOHLCV(pair, normalizeTf(timeframe), undefined, count);
    return ohlcv.map(([time, open, high, low, close, volume]) => ({
      time, open, high, low, close, volume,
    }));
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
