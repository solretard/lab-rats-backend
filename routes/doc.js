const express = require('express');
const router = express.Router();
const { getConnection, send, getTokenAndPool, getPoolTrades, poolAgeWarning } = require('../lib/xrplHelpers');

function parseDepositWithdrawAmounts(tx) {
  const result = { xrp: null, token: null };
  for (const field of [tx.Amount, tx.Amount2]) {
    if (typeof field === 'string') result.xrp = parseInt(field, 10) / 1e6;
    else if (field && typeof field === 'object') result.token = parseFloat(field.value);
  }
  return result;
}

// GET /api/doc/liquidity/:issuer
router.get('/liquidity/:issuer', async (req, res) => {
  const { issuer } = req.params;

  try {
    const ws = await getConnection();
    const { ammInfo } = await getTokenAndPool(ws, issuer);
    const { ammCreateLedger, ammCreateTime, initialXrp, trades } = await getPoolTrades(ws, ammInfo, issuer);

    const currentXrp = parseFloat(ammInfo.amount) / 1e6;
    const currentTokens = parseFloat(ammInfo.amount2?.value || 0);
    const totalVolumeXrp = trades.reduce((sum, t) => sum + t.xrp, 0);

    // Re-walk the same tx history for AMMDeposit/AMMWithdraw events —
    // getPoolTrades only extracts ordinary buy/sell Payments.
    const history = await send(ws, 'account_tx', { account: ammInfo.account, limit: 100, forward: true });
    const txs = history.result?.transactions || [];
    const lpEvents = [];
    txs.forEach((t) => {
      const tx = t.tx || t.tx_json || {};
      if (tx.TransactionType !== 'AMMDeposit' && tx.TransactionType !== 'AMMWithdraw') return;
      const ledger = tx.ledger_index || tx.inLedger;
      const amounts = parseDepositWithdrawAmounts(tx);
      const isDust = (amounts.xrp === null || amounts.xrp < 1) && (amounts.token === null || amounts.token < 1);
      lpEvents.push({
        type: tx.TransactionType === 'AMMDeposit' ? 'deposit' : 'withdraw',
        account: tx.Account, lag: ledger - ammCreateLedger, ...amounts, isDust,
      });
    });

    const realWithdrawals = lpEvents.filter((e) => e.type === 'withdraw' && !e.isDust && e.xrp !== null);
    const totalWithdrawn = realWithdrawals.reduce((sum, e) => sum + e.xrp, 0);
    const pctOfInitial = initialXrp > 0 ? (totalWithdrawn / initialXrp) * 100 : 0;
    const depthToVolumeRatio = totalVolumeXrp > 0 ? currentXrp / totalVolumeXrp : null;

    res.json({
      ammCreateLedger, ammCreateTime,
      warning: poolAgeWarning(ammCreateTime),
      currentXrp, currentTokens, initialXrp, totalVolumeXrp,
      lpEvents, totalWithdrawn, pctOfInitialWithdrawn: pctOfInitial,
      significantWithdrawal: pctOfInitial > 30,
      depthToVolumeRatio, thinLiquidity: depthToVolumeRatio !== null && depthToVolumeRatio < 0.15,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/doc/holders/:issuer
router.get('/holders/:issuer', async (req, res) => {
  const { issuer } = req.params;

  try {
    const ws = await getConnection();

    let lines = [];
    let marker;
    do {
      const resp = await send(ws, 'account_lines', { account: issuer, limit: 400, ...(marker ? { marker } : {}) });
      lines = lines.concat(resp.result?.lines || []);
      marker = resp.result?.marker;
    } while (marker);

    if (lines.length === 0) {
      return res.status(404).json({ error: 'No trustlines found for this issuer.' });
    }

    const currency = lines[0].currency;
    const holders = lines
      .map((l) => ({ account: l.account, balance: Math.abs(parseFloat(l.balance)) }))
      .filter((h) => h.balance > 0)
      .sort((a, b) => b.balance - a.balance);
    const totalSupply = holders.reduce((sum, h) => sum + h.balance, 0);

    let ammAccount = null;
    try {
      const amm = await send(ws, 'amm_info', { asset: { currency: 'XRP' }, asset2: { currency, issuer } });
      ammAccount = amm.result?.amm?.account || null;
    } catch (e) { /* fine if this fails */ }

    const topHolders = holders.slice(0, 10).map((h, i) => ({
      rank: i + 1, account: h.account, balance: h.balance,
      pct: (h.balance / totalSupply) * 100, isLiquidityPool: h.account === ammAccount,
    }));

    const nonPool = holders.filter((h) => h.account !== ammAccount);
    const top5Pct = (nonPool.slice(0, 5).reduce((s, h) => s + h.balance, 0) / totalSupply) * 100;
    const top10Pct = (nonPool.slice(0, 10).reduce((s, h) => s + h.balance, 0) / totalSupply) * 100;

    res.json({
      currency, totalHolders: holders.length, totalSupply,
      topHolders, top5Pct, top10Pct,
      riskLevel: top5Pct > 50 ? 'high' : top5Pct > 30 ? 'medium' : 'low',
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
