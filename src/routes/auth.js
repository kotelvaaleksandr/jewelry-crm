 const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');

const router = express.Router();

router.post('/register', async (req, res) => {
  const { email, password, company_name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email і пароль обовязкові' });
  try {
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length > 0) return res.status(400).json({ error: 'Email вже зареєстровано' });
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password, company_name) VALUES ($1, $2, $3) RETURNING id, email, company_name',
      [email, hash, company_name]
    );
    await pool.query('INSERT INTO settings (user_id) VALUES ($1)', [result.rows[0].id]);
    const token = jwt.sign({ userId: result.rows[0].id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email і пароль обовязкові' });
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'Невірний email або пароль' });
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Невірний email або пароль' });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, company_name: user.company_name } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const auth = require('../middleware/auth');

function matchesKeywords(description, keywords) {
  if (!description || !keywords.length) return false;
  const lower = description.toLowerCase();
  return keywords.some(k => lower.includes(k));
}

router.put('/profile', auth, async (req, res) => {
  const { company_name, last_name, first_name, phone, old_password, new_password } = req.body;
  try {
    if (old_password && new_password) {
      const userRes = await pool.query('SELECT password FROM users WHERE id=$1', [req.userId]);
      const valid = await bcrypt.compare(old_password, userRes.rows[0].password);
      if (!valid) return res.status(400).json({ error: 'Невірний поточний пароль' });
      const hash = await bcrypt.hash(new_password, 10);
      await pool.query('UPDATE users SET password=$1 WHERE id=$2', [hash, req.userId]);
    }
    const result = await pool.query(
      'UPDATE users SET company_name=$1, last_name=$2, first_name=$3, phone=$4 WHERE id=$5 RETURNING id, email, company_name, last_name, first_name, phone',
      [company_name, last_name || null, first_name || null, phone || null, req.userId]
    );
    res.json(result.rows[0]);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/keywords', auth, async (req, res) => {
  const r = await pool.query('SELECT internal_keywords FROM users WHERE id=$1', [req.userId]);
  res.json({ keywords: r.rows[0]?.internal_keywords || '' });
});

router.put('/keywords', auth, async (req, res) => {
  const { keywords } = req.body;
  await pool.query('UPDATE users SET internal_keywords=$1 WHERE id=$2', [keywords || '', req.userId]);
  res.json({ success: true });
});

// Перекласифікувати існуючі транзакції за ключовими словами
router.post('/apply-keywords', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT internal_keywords FROM users WHERE id=$1', [req.userId]);
    const raw = r.rows[0]?.internal_keywords || '';
    const keywords = raw.split(',').map(k => k.trim()).filter(Boolean);
    console.log('apply-keywords: raw=', JSON.stringify(raw), 'keywords=', keywords);
    if (!keywords.length) return res.json({ updated: 0, debug: 'no keywords' });

    // Будуємо умову: description ILIKE '%keyword1%' OR description ILIKE '%keyword2%'
    const likeConditions = keywords.map((_, i) => `description ILIKE $${i + 2}`).join(' OR ');
    const likeParams = keywords.map(k => `%${k}%`);

    // Debug: скільки записів знайдено
    const debugInc = await pool.query(
      `SELECT COUNT(*) as cnt FROM incomes WHERE user_id=$1 AND (${likeConditions})`,
      [req.userId, ...likeParams]
    );
    const debugExp = await pool.query(
      `SELECT COUNT(*) as cnt FROM expenses WHERE user_id=$1 AND (${likeConditions})`,
      [req.userId, ...likeParams]
    );
    console.log('apply-keywords debug: incomes found=', debugInc.rows[0].cnt, 'expenses found=', debugExp.rows[0].cnt);

    const incResult = await pool.query(
      `UPDATE incomes SET type='Внутрішній переказ'
       WHERE user_id=$1 AND type != 'Внутрішній переказ' AND (${likeConditions})`,
      [req.userId, ...likeParams]
    );
    const expResult = await pool.query(
      `UPDATE expenses SET category='Внутрішній переказ'
       WHERE user_id=$1 AND category != 'Внутрішній переказ' AND (${likeConditions})`,
      [req.userId, ...likeParams]
    );

    const updated = (incResult.rowCount || 0) + (expResult.rowCount || 0);
    console.log('apply-keywords: updated incomes=', incResult.rowCount, 'expenses=', expResult.rowCount);
    res.json({ updated });
  } catch(e) {
    console.error('apply-keywords error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
