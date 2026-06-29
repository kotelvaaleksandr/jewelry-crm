 const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

// Доходи
router.get('/incomes', auth, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM incomes WHERE user_id = $1 ORDER BY COALESCE(transaction_time, date::timestamp) DESC, id DESC',
    [req.userId]
  );
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
  const result = await pool.query(
    'SELECT * FROM expenses WHERE user_id = $1 ORDER BY COALESCE(transaction_time, date::timestamp) DESC, id DESC',
    [req.userId]
  );
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

// Типи доходів
const DEFAULT_INCOME_TYPES = ['Накладений платіж','Розрахунковий рахунок','Карта','Готівка','Інше'];
router.get('/income-types', auth, async (req, res) => {
  let result = await pool.query('SELECT * FROM income_types WHERE user_id=$1 ORDER BY name', [req.userId]);
  if (!result.rows.length) {
    for (const name of DEFAULT_INCOME_TYPES) {
      await pool.query('INSERT INTO income_types (user_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.userId, name]);
    }
    result = await pool.query('SELECT * FROM income_types WHERE user_id=$1 ORDER BY name', [req.userId]);
  }
  res.json(result.rows);
});
router.post('/income-types', auth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Назва обовязкова' });
  const result = await pool.query('INSERT INTO income_types (user_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING *', [req.userId, name.trim()]);
  res.json(result.rows[0] || { error: 'exists' });
});
router.put('/income-types/:id', auth, async (req, res) => {
  const { name } = req.body;
  await pool.query('UPDATE income_types SET name=$1 WHERE id=$2 AND user_id=$3', [name.trim(), req.params.id, req.userId]);
  res.json({ success: true });
});
router.delete('/income-types/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM income_types WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  res.json({ success: true });
});

// Категорії витрат
const DEFAULT_EXPENSE_CATS = ['Некласифіковано','Закупівля','Реклама','Binotel','Сайт','Пакування','Доставка','Податки','Зарплата','Інше'];
router.get('/expense-categories', auth, async (req, res) => {
  let result = await pool.query('SELECT * FROM expense_categories WHERE user_id=$1 ORDER BY name', [req.userId]);
  if (!result.rows.length) {
    for (const name of DEFAULT_EXPENSE_CATS) {
      await pool.query('INSERT INTO expense_categories (user_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.userId, name]);
    }
    result = await pool.query('SELECT * FROM expense_categories WHERE user_id=$1 ORDER BY name', [req.userId]);
  }
  res.json(result.rows);
});
router.post('/expense-categories', auth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Назва обовязкова' });
  const result = await pool.query('INSERT INTO expense_categories (user_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING *', [req.userId, name.trim()]);
  res.json(result.rows[0] || { error: 'exists' });
});
router.put('/expense-categories/:id', auth, async (req, res) => {
  const { name } = req.body;
  await pool.query('UPDATE expense_categories SET name=$1 WHERE id=$2 AND user_id=$3', [name.trim(), req.params.id, req.userId]);
  res.json({ success: true });
});
router.delete('/expense-categories/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM expense_categories WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  res.json({ success: true });
});

// Регулярні витрати
router.get('/regular-expenses', auth, async (req, res) => {
  const result = await pool.query('SELECT * FROM regular_expenses WHERE user_id=$1 ORDER BY name', [req.userId]);
  res.json(result.rows);
});
router.post('/regular-expenses', auth, async (req, res) => {
  const { name, amount, period, pay_day, pay_month, pay_date } = req.body;
  if (!name || !amount || !period) return res.status(400).json({ error: 'Заповніть всі обовязкові поля' });
  const result = await pool.query(
    'INSERT INTO regular_expenses (user_id, name, amount, period, pay_day, pay_month, pay_date) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [req.userId, name.trim(), amount, period, pay_day || null, pay_month || null, pay_date || null]
  );
  res.json(result.rows[0]);
});
router.put('/regular-expenses/:id', auth, async (req, res) => {
  const { name, amount, period, pay_day, pay_month, pay_date } = req.body;
  await pool.query(
    'UPDATE regular_expenses SET name=$1, amount=$2, period=$3, pay_day=$4, pay_month=$5, pay_date=$6 WHERE id=$7 AND user_id=$8',
    [name.trim(), amount, period, pay_day || null, pay_month || null, pay_date || null, req.params.id, req.userId]
  );
  res.json({ success: true });
});
router.delete('/regular-expenses/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM regular_expenses WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
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
