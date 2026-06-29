const express = require('express');
const https = require('https');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    https.get({ hostname: opts.hostname, path: opts.pathname, headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

router.get('/', auth, async (req, res) => {
  const result = await pool.query('SELECT provider, account_id, enabled, last_sync FROM integrations WHERE user_id = $1', [req.userId]);
  res.json(result.rows);
});

// Отримати список рахунків Monobank за токеном
router.post('/monobank/accounts', auth, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Токен відсутній' });
  try {
    const data = await httpsGet('https://api.monobank.ua/personal/client-info', { 'X-Token': token });
    if (data.errorDescription) return res.status(400).json({ error: data.errorDescription });
    const typeNames = { black: 'Чорна карта', white: 'Біла карта', platinum: 'Платинова', iron: 'Залізна', fop: 'ФОП', yellow: 'Жовта', eAid: 'єПідтримка', madeInUkraine: 'Зроблено в Україні' };
    const currencies = { 980: 'UAH', 840: 'USD', 978: 'EUR' };
    const accounts = data.accounts.map(a => ({
      id: a.id,
      name: typeNames[a.type] || a.type,
      currency: currencies[a.currencyCode] || a.currencyCode,
      balance: a.balance / 100,
      iban: a.iban,
      type: a.type
    }));
    res.json({ clientName: data.name, accounts });
  } catch (e) {
    res.status(500).json({ error: 'Помилка підключення до Monobank' });
  }
});

// Зберегти інтеграцію з вибраним рахунком
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

// Синхронізація транзакцій Monobank
router.post('/monobank/sync', auth, async (req, res) => {
  try {
    const intResult = await pool.query(
      'SELECT token, account_id FROM integrations WHERE user_id=$1 AND provider=$2 AND enabled=true',
      [req.userId, 'monobank']
    );
    if (!intResult.rows.length) return res.status(400).json({ error: 'Monobank не підключено' });
    const { token, account_id } = intResult.rows[0];

    const from = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
    const to = Math.floor(Date.now() / 1000);
    const url = `https://api.monobank.ua/personal/statement/${account_id}/${from}/${to}`;
    const data = await httpsGet(url, { 'X-Token': token });

    if (!Array.isArray(data)) return res.status(400).json({ error: data.errorDescription || 'Помилка API' });

    let added = 0;
    for (const tx of data) {
      const amount = tx.amount / 100;
      const date = new Date(tx.time * 1000).toISOString().split('T')[0];
      const description = tx.description || '';
      if (amount > 0) {
        await pool.query(
          `INSERT INTO incomes (user_id, amount, type, description, date, bank_tx_id)
           VALUES ($1,$2,'Monobank',$3,$4,$5)
           ON CONFLICT (bank_tx_id) DO NOTHING`,
          [req.userId, amount, description, date, tx.id]
        );
      } else {
        await pool.query(
          `INSERT INTO expenses (user_id, amount, category, description, date, bank_tx_id)
           VALUES ($1,$2,'Некласифіковано',$3,$4,$5)
           ON CONFLICT (bank_tx_id) DO NOTHING`,
          [req.userId, Math.abs(amount), description, date, tx.id]
        );
      }
      added++;
    }

    await pool.query('UPDATE integrations SET last_sync=NOW() WHERE user_id=$1 AND provider=$2', [req.userId, 'monobank']);
    res.json({ success: true, synced: added });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:provider', auth, async (req, res) => {
  await pool.query(
    'UPDATE integrations SET enabled=false, token=null, account_id=null WHERE user_id=$1 AND provider=$2',
    [req.userId, req.params.provider]
  );
  res.json({ success: true });
});

module.exports = router;
