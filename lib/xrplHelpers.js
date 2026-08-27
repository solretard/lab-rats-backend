const WebSocket = require('ws');

const NODE_URL = process.env.XRPL_NODE || 'wss://xrplcluster.com';
const RIPPLE_EPOCH = 946684800;

let cachedClient = null;

/**
 * Returns a live WebSocket connection, reconnecting automatically if the
 * previous one dropped (XRPL nodes close idle connections after a while).
 */
function getConnection() {
  return new Promise((resolve, reject) => {
    if (cachedClient && cachedClient.readyState === WebSocket.OPEN) {
      return resolve(cachedClient);
    }
    const ws = new WebSocket(NODE_URL);
    ws.on('open', () => {
      cachedClient = ws;
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

/**
 * Sends a single request/response command over an existing connection.
 * Each call gets its own listener so concurrent requests don't collide.
 */
function send(ws, command, params) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const timeout = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error(`Timed out waiting for response to ${command}`));
    }, 15000);

    function handler(data) {
      const msg = JSON.parse(data);
      if (msg.id === id) {
        clearTimeout(timeout);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    }
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, command, ...params }));
  });
}

function ledgerTimeToDate(rippleTime) {
  return new Date((rippleTime + RIPPLE_EPOCH) * 1000);
}

/**
 * Looks up a token's currency code and its XRP/token AMM pool in one go —
 * every tool needs this same starting point.
 */
async function getTokenAndPool(ws, issuer) {
  const lines = await send(ws, 'account_lines', { account: issuer, limit: 1 });
  const currency = lines.result?.lines?.[0]?.currency;
  if (!currency) {
    const err = new Error('Could not find a currency code for this issuer.');
    err.status = 404;
    throw err;
  }

  const amm = await send(ws, 'amm_info', {
    asset: { currency: 'XRP' },
    asset2: { currency, issuer },
  });
  const ammInfo = amm.result?.amm;
  if (!ammInfo) {
    const err = new Error('No XRP/token AMM pool found for this issuer.');
    err.status = 404;
    throw err;
  }

  return { currency, ammInfo };
}

/**
 * Fetches a pool's transaction history from creation onward, extracting
 * every buy/sell into a consistent shape used by Twitch, Whiskers, and
 * Squint's tools.
 */
async function getPoolTrades(ws, ammInfo, issuer) {
  const history = await send(ws, 'account_tx', {
    account: ammInfo.account,
    limit: 100,
    forward: true,
  });
  const txs = history.result?.transactions || [];

  let ammCreateLedger = null;
  let ammCreateTime = null;
  let initialXrp = 0;
  const trades = [];

  txs.forEach((t) => {
    const tx = t.tx || t.tx_json || {};
    const ledger = tx.ledger_index || tx.inLedger;
    const date = tx.date ? ledgerTimeToDate(tx.date) : null;
    const delivered = t.meta?.delivered_amount;

    if (tx.TransactionType === 'AMMCreate' && !ammCreateLedger) {
      ammCreateLedger = ledger;
      ammCreateTime = date;
      for (const field of [tx.Amount, tx.Amount2]) {
        if (typeof field === 'string') initialXrp = parseInt(field, 10) / 1e6;
      }
      return;
    }
    if (!ammCreateLedger || tx.TransactionType !== 'Payment' || tx.Account === issuer) return;

    const tokensReceived = typeof delivered === 'object' ? parseFloat(delivered.value || 0) : 0;
    const xrpSpent = typeof tx.SendMax === 'string' ? parseInt(tx.SendMax, 10) / 1e6 : 0;
    const tokensSent = typeof tx.SendMax === 'object' ? parseFloat(tx.SendMax.value || 0) : 0;
    const xrpReceived = typeof delivered === 'string' ? parseInt(delivered, 10) / 1e6 : 0;

    if (xrpSpent > 0 && tokensReceived > 0) {
      trades.push({
        type: 'buy', account: tx.Account, ledger, lag: ledger - ammCreateLedger, date,
        xrp: xrpSpent, tokens: tokensReceived, price: xrpSpent / tokensReceived,
      });
    } else if (tokensSent > 0 && xrpReceived > 0) {
      trades.push({
        type: 'sell', account: tx.Account, ledger, lag: ledger - ammCreateLedger, date,
        xrp: xrpReceived, tokens: tokensSent, price: xrpReceived / tokensSent,
      });
    }
  });

  if (!ammCreateLedger) {
    const err = new Error("Could not find this pool's AMMCreate transaction in recent history.");
    err.status = 404;
    throw err;
  }

  return { ammCreateLedger, ammCreateTime, initialXrp, trades };
}

function poolAgeWarning(ammCreateTime) {
  const days = (Date.now() - ammCreateTime.getTime()) / (1000 * 60 * 60 * 24);
  if (days > 7) {
    return `this pool is ${days.toFixed(1)} days old — these tools are built for fresh launches, results may be incomplete.`;
  }
  return null;
}

module.exports = {
  getConnection, send, ledgerTimeToDate, getTokenAndPool, getPoolTrades, poolAgeWarning,
};
