const express = require('express');
const router = express.Router();
const { getConnection, send, ledgerTimeToDate, getTokenAndPool, getPoolTrades, poolAgeWarning } = require('../lib/xrplHelpers');

// GET /api/squint/growth/:issuer
router.get('/growth/:issuer', async (req, res) => {
  const { issuer } = req.params;

  try {
    const ws = await getConnection();
    const lines = await send(ws, 'account_lines', { account: issuer, limit: 1 });
    const currency = lines.result?.lines?.[0]?.currency;
    if (!currency) return res.status(404).json({ error: 'Could not find a currency code for this issuer.' });

    let allTxs = [];
    let marker;
    let pages = 0;
    do {
      const resp = await send(ws, 'account_tx', { account: issuer, limit: 200, forward: true, ...(marker ? { marker } : {}) });
      allTxs = allTxs.concat(resp.result?.transactions || []);
      marker = resp.result?.marker;
      pages++;
    } while (marker && pages < 10); // safety cap for very high-activity issuers

    const trustEvents = [];
    allTxs.forEach((t) => {
      const tx = t.tx || t.tx_json || {};
      if (tx.TransactionType !== 'TrustSet') return;
      const limitAmt = tx.LimitAmount;
      if (!limitAmt || limitAmt.currency !== currency || limitAmt.issuer !== issuer) return;

      const ledger = tx.ledger_index || tx.inLedger;
      const date = tx.date ? ledgerTimeToDate(tx.date) : null;
      const nodes = t.meta?.AffectedNodes || [];
      let event = null;
      for (const node of nodes) {
        const isThisLine = (fields) => fields?.HighLimit?.currency === currency || fields?.LowLimit?.currency === currency;
        if (node.CreatedNode?.LedgerEntryType === 'RippleState' && isThisLine(node.CreatedNode.NewFields)) { event = 'opened'; break; }
        if (node.DeletedNode?.LedgerEntryType === 'RippleState' && isThisLine(node.DeletedNode.FinalFields)) { event = 'closed'; break; }
      }
      if (event) trustEvents.push({ account: tx.Account, ledger, date, opened: event === 'opened' });
    });

    if (trustEvents.length === 0) {
      return res.json({ noActivity: true });
    }

    trustEvents.sort((a, b) => a.ledger - b.ledger);
    const first = trustEvents[0];

    const bucketMs = 60 * 60 * 1000;
    const buckets = {};
    trustEvents.forEach((t) => {
      const idx = Math.floor((t.date.getTime() - first.date.getTime()) / bucketMs);
      buckets[idx] = buckets[idx] || { opens: 0, closes: 0 };
      if (t.opened) buckets[idx].opens++; else buckets[idx].closes++;
    });

    const bucketKeys = Object.keys(buckets).map(Number).sort((a, b) => a - b);
    let running = 0;
    const timeline = bucketKeys.map((k) => {
      const b = buckets[k];
      running += b.opens - b.closes;
      return { hour: k, opens: b.opens, closes: b.closes, net: b.opens - b.closes, runningTotal: running };
    });

    const recentCount = Math.max(1, Math.floor(bucketKeys.length / 3));
    const recentKeys = bucketKeys.slice(-recentCount);
    const earlierKeys = bucketKeys.slice(0, -recentCount);
    const recentAvg = recentKeys.reduce((s, k) => s + (buckets[k].opens - buckets[k].closes), 0) / recentKeys.length;
    const earlierAvg = earlierKeys.length > 0
      ? earlierKeys.reduce((s, k) => s + (buckets[k].opens - buckets[k].closes), 0) / earlierKeys.length
      : recentAvg;

    const totalOpens = trustEvents.filter((t) => t.opened).length;
    const totalCloses = trustEvents.length - totalOpens;
    const churnRate = totalOpens > 0 ? totalCloses / totalOpens : 0;

    let trend;
    if (recentAvg > earlierAvg * 1.2) trend = 'accelerating';
    else if (recentAvg < earlierAvg * 0.5) trend = 'slowing';
    else if (recentAvg < 0) trend = 'declining';
    else trend = 'steady';

    res.json({
      firstEventLedger: first.ledger, timeline, recentAvg, earlierAvg, trend,
      totalOpens, totalCloses, churnRate, highChurn: churnRate > 0.5,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/squint/pattern/:issuer
router.get('/pattern/:issuer', async (req, res) => {
  const { issuer } = req.params;

  try {
    const ws = await getConnection();
    const { ammInfo } = await getTokenAndPool(ws, issuer);
    const { trades } = await getPoolTrades(ws, ammInfo, issuer);

    if (trades.length === 0) {
      return res.status(404).json({ error: 'No trades found to analyze a pattern from.' });
    }

    const buys = trades.filter((t) => t.type === 'buy');
    const sells = trades.filter((t) => t.type === 'sell');
    const buyVolume = buys.reduce((s, t) => s + t.xrp, 0);
    const sellVolume = sells.reduce((s, t) => s + t.xrp, 0);
    const totalVolume = buyVolume + sellVolume;

    const firstFiveVolume = trades.filter((t) => t.lag <= 5).reduce((s, t) => s + t.xrp, 0);
    const earlyConcentration = totalVolume > 0 ? firstFiveVolume / totalVolume : 0;

    const peak = trades.reduce((a, b) => (b.price > a.price ? b : a));
    const latest = trades[trades.length - 1];
    const pctFromPeak = ((latest.price - peak.price) / peak.price) * 100;

    let pattern;
    if (earlyConcentration > 0.6 && pctFromPeak < -40) {
      pattern = { name: 'PUMP AND DUMP shape', risk: 'high',
        note: 'heavy volume concentrated right at launch, followed by a sharp decline.' };
    } else if (peak.lag <= 3 && pctFromPeak < -20) {
      pattern = { name: 'BOT-DOMINATED FLASH shape', risk: 'medium-high',
        note: 'price peaked almost immediately — early action looks like bots racing each other, not organic demand.' };
    } else if (buyVolume > sellVolume * 1.5 && pctFromPeak > -30) {
      pattern = { name: 'HEALTHY ACCUMULATION shape', risk: 'low',
        note: 'more buying than selling, price has held up reasonably close to peak.' };
    } else if (sellVolume > buyVolume) {
      pattern = { name: 'SLOW BLEED shape', risk: 'medium',
        note: 'more selling than buying overall — downward pressure worth watching.' };
    } else {
      pattern = { name: 'MIXED / UNCLEAR shape', risk: 'unclear',
        note: "doesn't cleanly match a recognizable pattern yet." };
    }

    res.json({
      totalTrades: trades.length, buyCount: buys.length, sellCount: sells.length,
      buyToSellRatio: sellVolume > 0 ? buyVolume / sellVolume : null,
      earlyConcentrationPct: earlyConcentration * 100,
      peakLag: peak.lag, pctFromPeak, pattern,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
