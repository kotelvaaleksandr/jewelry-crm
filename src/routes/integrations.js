const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

router.get('/', auth, async (req, res) => {
  const result = await pool.query('SELECT * FROM integrations WHERE user_id = $1', [req.userId]);
  res.json(result.rows);
});

router.post('/:provider', auth, async (req, res) => {
  const { provider } = req.params;
  const { token, account_id } = req.body;
  if (!['monobank', 'privatbank', 'novapay'].includes(provider)) {
    return res.status(400).json({ error: 'Невідомий провайдер' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO integrations (user_id, provider, token, account_id, enabled)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (user_id, provider)
       DO UPDATE SET token=$3, account_id=$4, enabled=true
       RETURNING *`,
      [req.userId, provider, token, account_id || null]
    );
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:provider', auth, async (req, res) => {
  await pool.query(
    'UPDATE integrations SET enabled=false, token=null WHERE user_id=$1 AND provider=$2',
    [req.userId, req.params.provider]
  );
  res.json({ success: true });
});

module.exports = router;
