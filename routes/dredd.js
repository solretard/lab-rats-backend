const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { getConnection, ownsNftFromIssuer } = require('../lib/xrplHelpers');

// Set this once Dredd Doctors actually mints — the wallet that issues the collection.
const DREDD_NFT_ISSUER = process.env.LAB_RATS_NFT_ISSUER || null;

// Set this to any secret string you choose — only people who know this key
// can see the admin view. Not a full auth system, but keeps casual visitors out.
const ADMIN_KEY = process.env.DREDD_ADMIN_KEY || null;

// GET /api/dredd/admin/experiments?key=... — full detail view, admin only
router.get('/admin/experiments', async (req, res) => {
  const { key } = req.query;
  if (!ADMIN_KEY) {
    return res.status(500).json({ error: 'DREDD_ADMIN_KEY not set on the server.' });
  }
  if (key !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid admin key.' });
  }

  const { data, error } = await supabase
    .from('experiments')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'Failed to load experiments.' });
  res.json({ experiments: data });
});

// GET /api/dredd/experiments — public board, sorted by upvotes
router.get('/experiments', async (req, res) => {
  const { data, error } = await supabase
    .from('experiments')
    .select('*')
    .order('upvotes', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'Failed to load experiments.' });
  res.json({ experiments: data });
});

// GET /api/dredd/check/:wallet — read-only check, tells the frontend whether
// to show the submission form at all.
router.get('/check/:wallet', async (req, res) => {
  const { wallet } = req.params;

  if (!DREDD_NFT_ISSUER) {
    return res.json({ eligible: false, note: 'Dredd Doctors has not launched yet — the board opens once minting is live.' });
  }

  try {
    const ws = await getConnection();
    const result = await ownsNftFromIssuer(ws, wallet, DREDD_NFT_ISSUER);
    if (result.owns) {
      return res.json({ eligible: true, tokenIds: result.tokenIds });
    }
    return res.json({
      eligible: false,
      tokenIds: [],
      note: 'This wallet doesn\'t hold a Dredd Doctor yet — mint one to unlock submissions.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dredd/submit — { wallet, title, description }
// Verifies NFT ownership server-side too (never trust the frontend check alone).
router.post('/submit', async (req, res) => {
  const { wallet, title, description } = req.body;
  if (!wallet || !title || !description) {
    return res.status(400).json({ error: 'wallet, title, and description are all required.' });
  }
  if (!DREDD_NFT_ISSUER) {
    return res.status(403).json({ error: 'Dredd Doctors has not launched yet.' });
  }

  try {
    const ws = await getConnection();
    const ownership = await ownsNftFromIssuer(ws, wallet, DREDD_NFT_ISSUER);
    if (!ownership.owns) {
      return res.status(403).json({ error: 'This wallet does not hold a Dredd Doctor — only holders can submit experiments.' });
    }

    const { data, error } = await supabase
      .from('experiments')
      .insert({
        title, description,
        submitted_by: wallet,
        nft_token_id: ownership.tokenIds[0] || null,
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ status: 'submitted', experiment: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dredd/vote — { experimentId, wallet }
// One vote per wallet per experiment, enforced by a unique constraint in
// the database — this call just tries the insert and reports the outcome.
router.post('/vote', async (req, res) => {
  const { experimentId, wallet } = req.body;
  if (!experimentId || !wallet) {
    return res.status(400).json({ error: 'experimentId and wallet are required.' });
  }

  try {
    const { error: voteError } = await supabase
      .from('experiment_votes')
      .insert({ experiment_id: experimentId, voter_wallet: wallet });

    if (voteError) {
      if (voteError.code === '23505') { // unique constraint violation
        return res.status(409).json({ error: 'This wallet has already voted on this experiment.' });
      }
      throw voteError;
    }

    const { data: exp, error: fetchError } = await supabase
      .from('experiments')
      .select('upvotes')
      .eq('id', experimentId)
      .single();
    if (fetchError) throw fetchError;

    const { error: updateError } = await supabase
      .from('experiments')
      .update({ upvotes: exp.upvotes + 1 })
      .eq('id', experimentId);
    if (updateError) throw updateError;

    res.json({ status: 'voted', upvotes: exp.upvotes + 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
