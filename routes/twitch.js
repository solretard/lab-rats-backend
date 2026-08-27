const express = require('express');
const router = express.Router();
const { getConnection, getTokenAndPool, getPoolTrades, poolAgeWarning } = require('../lib/xrplHelpers');

// GET /api/twitch/entry/:issuer?wallet=rXXX
router.get('/entry/:issuer', async (req, res) => {
  const { issuer } = req.params;
  const { wallet } = req.query;

  try {
    const ws = await getConnection();
    const { ammInfo } = await getTokenAndPool(ws, issuer);
    const { ammCreateLedger, ammCreateTime, trades } = await getPoolTrades(ws, ammInfo, issuer);
    const buys = trades.filter((t) => t.type === 'buy');

    const leaderboard = buys.slice(0, 10).map((b, i) => ({
      rank: i + 1, account: b.account, lag: b.lag, xrp: b.xrp, tokens: b.tokens,
    }));

    let yourResult = null;
    if (wallet) {
      const yourBuys = buys.filter((b) => b.account === wallet);
      if (yourBuys.length > 0) {
        const rank = buys.findIndex((b) => b === yourBuys[0]) + 1;
        const best = buys[0];
        yourResult = {
          found: true, lag: yourBuys[0].lag, rank, totalBuyers: buys.length,
          xrp: yourBuys[0].xrp, tokens: yourBuys[0].tokens,
          ledgersBehindFirst: best.account !== wallet ? yourBuys[0].lag - best.lag : 0,
        };
      } else {
        yourResult = { found: false };
      }
    }

    res.json({
      ammCreateLedger, ammCreateTime,
      warning: poolAgeWarning(ammCreateTime),
      totalBuys: buys.length, leaderboard, yourResult,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/twitch/exit/:issuer?wallet=rXXX
router.get('/exit/:issuer', async (req, res) => {
  const { issuer } = req.params;
  const { wallet } = req.query;

  try {
    const ws = await getConnection();
    const { ammInfo } = await getTokenAndPool(ws, issuer);
    const { ammCreateLedger, ammCreateTime, trades } = await getPoolTrades(ws, ammInfo, issuer);

    if (trades.length === 0) {
      return res.json({ ammCreateLedger, ammCreateTime, warning: poolAgeWarning(ammCreateTime), noTrades: true });
    }

    const peak = trades.reduce((a, b) => (b.price > a.price ? b : a));
    const latest = trades[trades.length - 1];
    const pctFromPeak = ((latest.price - peak.price) / peak.price) * 100;

    let yourResult = null;
    if (wallet) {
      const yourSells = trades.filter((t) => t.type === 'sell' && t.account === wallet);
      if (yourSells.length > 0) {
        yourResult = yourSells.map((s) => ({
          price: s.price, lag: s.lag, date: s.date,
          missedPct: ((peak.price - s.price) / s.price) * 100,
          ledgersBeforePeak: peak.ledger - s.ledger,
        }));
      } else {
        yourResult = { stillHolding: true, currentPctFromPeak: pctFromPeak };
      }
    }

    res.json({
      ammCreateLedger, ammCreateTime,
      warning: poolAgeWarning(ammCreateTime),
      totalTrades: trades.length,
      peak: { price: peak.price, lag: peak.lag, date: peak.date },
      latest: { price: latest.price, lag: latest.lag },
      pctFromPeak, yourResult,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
