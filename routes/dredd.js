const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { getConnection, ownsNftFromIssuer } = require('../lib/xrplHelpers');

// Set this once Lab Rats actually mints — the wallet that issues the collection.
const LAB_RATS_NFT_ISSUER = process.env.LAB_RATS_NFT_ISSUER || null;

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

  if (!LAB_RATS_NFT_ISSUER) {
    return res.json({ eligible: false, note: 'Lab Rats has not launched yet — the board opens once minting is live.' });
  }

  try {
    const ws = await getConnection();
    const result = await ownsNftFromIssuer(ws, wallet, LAB_RATS_NFT_ISSUER);
    res.json({ eligible: result.owns, tokenIds: result.tokenIds });
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
  if (!LAB_RATS_NFT_ISSUER) {
    return res.status(403).json({ error: 'Lab Rats has not launched yet.' });
  }

  try {
    const ws = await getConnection();
    const ownership = await ownsNftFromIssuer(ws, wallet, LAB_RATS_NFT_ISSUER);
    if (!ownership.owns) {
      return res.status(403).json({ error: 'This wallet does not hold a Lab Rat — only holders can submit experiments.' });
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
