 const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

// Доходи
router.get('/incomes', auth, async (req, res) => {
  const result = await pool.query('SELECT * FROM incomes WHERE user_id = $1 ORDER BY date DESC', [req.userId]);
  res.json(result.rows);
});

router.post('/incomes', auth, async (req, res) => {
  const { amount, type, description, date } = req.body;
  const result = await pool.query(
    'INSERT INTO incomes (user_id, amount, type, description, date) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [req.userId, amount, type, description, date]
  );
  res.json(result.rows[0]);
});

router.put('/incomes/:id', auth, async (req, res) => {
  const { type } = req.body;
  await pool.query('UPDATE incomes SET type=$1 WHERE id=$2 AND user_id=$3', [type, req.params.id, req.userId]);
  res.json({ success: true });
});

router.delete('/incomes/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM incomes WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  res.json({ success: true });
});

// Витрати
router.get('/expenses', auth, async (req, res) => {
  const result = await pool.query('SELECT * FROM expenses WHERE user_id = $1 ORDER BY date DESC', [req.userId]);
  res.json(result.rows);
});

router.post('/expenses', auth, async (req, res) => {
  const { amount, category, description, date } = req.body;
  const result = await pool.query(
    'INSERT INTO expenses (user_id, amount, category, description, date) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [req.userId, amount, category, description, date]
  );
  res.json(result.rows[0]);
});

router.put('/expenses/:id', auth, async (req, res) => {
  const { category } = req.body;
  await pool.query('UPDATE expenses SET category=$1 WHERE id=$2 AND user_id=$3', [category, req.params.id, req.userId]);
  res.json({ success: true });
});

router.delete('/expenses/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM expenses WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  res.json({ success: true });
});

// Закупівлі
router.get('/purchases', auth, async (req, res) => {
  const result = await pool.query('SELECT * FROM purchases WHERE user_id = $1 ORDER BY date DESC', [req.userId]);
  res.json(result.rows);
});

router.post('/purchases', auth, async (req, res) => {
  const { amount, supplier, description, date } = req.body;
  const result = await pool.query(
    'INSERT INTO purchases (user_id, amount, supplier, description, date) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [req.userId, amount, supplier, description, date]
  );
  res.json(result.rows[0]);
});

router.delete('/purchases/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM purchases WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  res.json({ success: true });
});

// Налаштування
router.get('/settings', auth, async (req, res) => {
  const result = await pool.query('SELECT * FROM settings WHERE user_id = $1', [req.userId]);
  res.json(result.rows[0]);
});

router.put('/settings', auth, async (req, res) => {
  const { markup_ratio, purchase_percent, ads_percent, buffer_percent, mandatory_percent } = req.body;
  const result = await pool.query(
    `UPDATE settings SET markup_ratio=$1, purchase_percent=$2, ads_percent=$3, buffer_percent=$4, mandatory_percent=$5
     WHERE user_id=$6 RETURNING *`,
    [markup_ratio, purchase_percent, ads_percent, buffer_percent, mandatory_percent, req.userId]
  );
  res.json(result.rows[0]);
});

module.exports = router;
