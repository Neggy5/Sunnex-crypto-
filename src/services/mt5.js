const logger = require('../utils/logger');

// Real trading via MetaApi.cloud — connects to your actual MT5 account
// (demo or live, whichever accountId you configure). This module is only
// loaded/used when METAAPI_TOKEN + METAAPI_ACCOUNT_ID are set; without
// them, MT5 features are disabled and the rest of the bot is unaffected.
//
// IMPORTANT: crypto pairs here are priced off Binance/Bybit (BTC/USDT etc),
// but MT5 brokers quote their own CFD symbols (e.g. "BTCUSD") on their own
// price feed — the two are NOT the same price. Using a Binance-computed
// absolute price as your MT5 stop-loss/take-profit would very likely land
// in the wrong place. Instead, this module takes the *distance* (in price
// units) from the original signal and re-applies it to the live MT5 price
// at the moment the trade is actually placed, so the risk:reward shape of
// the signal is preserved even though the execution venue differs.

let MetaApi;
let api;
let account;
let connection;
let connecting;

const METAAPI_TOKEN = process.env.METAAPI_TOKEN;
const METAAPI_ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID;

// Maps our crypto-pair strings to your broker's actual MT5 symbol names.
// Broker symbol naming varies a lot (BTCUSD, BTCUSDm, BTCUSD.a, etc) — set
// this to match what's in your MT5 Market Watch exactly.
let SYMBOL_MAP = {};
try {
  SYMBOL_MAP = JSON.parse(process.env.MT5_SYMBOL_MAP || '{}');
} catch {
  logger.error('MT5_SYMBOL_MAP is not valid JSON — MT5 symbol mapping disabled.');
}

function isConfigured() {
  return Boolean(METAAPI_TOKEN && METAAPI_ACCOUNT_ID);
}

function mapSymbol(pair) {
  return SYMBOL_MAP[pair] || null;
}

async function connect() {
  if (!isConfigured()) return null;
  if (connection) return connection;
  if (connecting) return connecting;

  connecting = (async () => {
    // eslint-disable-next-line global-require
    MetaApi = require('metaapi.cloud-sdk').default;
    api = new MetaApi(METAAPI_TOKEN);
    account = await api.metatraderAccountApi.getAccount(METAAPI_ACCOUNT_ID);

    if (account.state !== 'DEPLOYED') {
      logger.info('MT5 account not deployed yet — deploying...');
      await account.deploy();
    }
    logger.info('Waiting for MT5 account connection...');
    await account.waitConnected();

    connection = account.getRPCConnection();
    await connection.connect();
    await connection.waitSynchronized();
    logger.info('MT5 connected via MetaApi.');
    return connection;
  })();

  try {
    return await connecting;
  } catch (err) {
    connecting = null;
    logger.error(`MT5 connect failed: ${err.message}`);
    throw err;
  }
}

async function getAccountInfo() {
  const conn = await connect();
  if (!conn) throw new Error('MT5 not configured (missing METAAPI_TOKEN/METAAPI_ACCOUNT_ID)');
  return conn.getAccountInformation();
}

async function getMt5Price(mt5Symbol) {
  const conn = await connect();
  const price = await conn.getSymbolPrice(mt5Symbol);
  return { bid: price.bid, ask: price.ask };
}

/**
 * Places a real market order with SL/TP derived from the signal's original
 * risk distances, re-applied to the live MT5 price. Returns the broker
 * ticket + actual fill/SL/TP used.
 */
async function placeTrade({
  pair, direction, lotSize, stopDistance, takeDistance,
}) {
  const mt5Symbol = mapSymbol(pair);
  if (!mt5Symbol) {
    throw new Error(`No MT5 symbol mapped for ${pair} — set MT5_SYMBOL_MAP`);
  }

  const conn = await connect();
  const { bid, ask } = await getMt5Price(mt5Symbol);
  const entry = direction === 'BUY' ? ask : bid;
  const stopLoss = direction === 'BUY' ? entry - stopDistance : entry + stopDistance;
  const takeProfit = direction === 'BUY' ? entry + takeDistance : entry - takeDistance;

  const result = direction === 'BUY'
    ? await conn.createMarketBuyOrder(mt5Symbol, lotSize, stopLoss, takeProfit)
    : await conn.createMarketSellOrder(mt5Symbol, lotSize, stopLoss, takeProfit);

  logger.info(`MT5 order placed: ${direction} ${lotSize} ${mt5Symbol} @ ~${entry} SL:${stopLoss} TP:${takeProfit} ticket:${result.orderId}`);

  return {
    ticket: result.orderId,
    mt5Symbol,
    openPrice: entry,
    stopLoss,
    takeProfit,
  };
}

async function getOpenPositions() {
  const conn = await connect();
  return conn.getPositions();
}

async function closePosition(positionId) {
  const conn = await connect();
  return conn.closePosition(positionId);
}

module.exports = {
  isConfigured, mapSymbol, connect, getAccountInfo, getMt5Price, placeTrade, getOpenPositions, closePosition,
};
