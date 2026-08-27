const express = require('express');
const router = express.Router();
const { getConnection, getTokenAndPool, getPoolTrades, poolAgeWarning } = require('../lib/xrplHelpers');

function classify(lag) {
  if (lag <= 1) return { label: 'BOT (high confidence)', isBot: true };
  if (lag <= 3) return { label: 'bot (medium confidence)', isBot: true };
  return { label: 'likely human', isBot: false };
}

// GET /api/whiskers/snipe/:issuer
router.get('/snipe/:issuer', async (req, res) => {
  const { issuer } = req.params;

  try {
    const ws = await getConnection();
    const { ammInfo } = await getTokenAndPool(ws, issuer);
    const { ammCreateLedger, ammCreateTime, trades } = await getPoolTrades(ws, ammInfo, issuer);
    const buys = trades.filter((t) => t.type === 'buy');

    const earlyBuys = buys.filter((b) => b.lag <= 5);
    const amountCounts = {};
    earlyBuys.forEach((b) => {
      const rounded = Math.round(b.xrp * 1000) / 1000;
      amountCounts[rounded] = (amountCounts[rounded] || 0) + 1;
    });
    const duplicatedAmounts = Object.entries(amountCounts)
      .filter(([, count]) => count >= 3)
      .map(([amount, count]) => ({ amount: parseFloat(amount), count }));

    const checked = buys.slice(0, 15).map((b, i) => {
      const c = classify(b.lag);
      const rounded = Math.round(b.xrp * 1000) / 1000;
      return {
        rank: i + 1, account: b.account, lag: b.lag, xrp: b.xrp,
        label: c.label, isBot: c.isBot,
        matchesRepeatedAmount: amountCounts[rounded] >= 3,
      };
    });

    const botCount = checked.filter((c) => c.isBot).length;
    const botPct = checked.length > 0 ? Math.round((botCount / checked.length) * 100) : 0;

    res.json({
      ammCreateLedger, ammCreateTime,
      warning: poolAgeWarning(ammCreateTime),
      buyers: checked, botCount, totalChecked: checked.length, botPct,
      duplicatedAmounts,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
