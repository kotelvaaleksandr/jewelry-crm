const express = require('express');
const https = require('https');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    https.get({ hostname: opts.hostname, path: opts.pathname + (opts.search || ''), headers }, res => {
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

// ПриватБанк — отримати список рахунків
router.post('/privatbank/accounts', auth, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Токен відсутній' });
  // Видаляємо пробіли та переноси рядків з токену
  const cleanToken = token.replace(/\s+/g, '');
  try {
    const data = await httpsGet('https://acp.privatbank.ua/api/statements/accounts', {
      'token': cleanToken,
      'Content-Type': 'application/json',
      'User-Agent': 'JewelryCRM/1.0'
    });
    console.log('PrivatBank accounts response:', JSON.stringify(data).substring(0, 300));
    if (data.status !== 'OK') {
      return res.status(400).json({
        error: `ПриватБанк API: ${data.message || data.status || JSON.stringify(data)}`,
        hint: 'Переконайтесь що скопіювали повний токен без зайвих символів. Також перевірте вкладку "ID і Token" — можливо потрібен інший формат.'
      });
    }
    const accounts = (data.data || []).map(a => ({
      id: a.acc,
      iban: a.acc,
      currency: a.currency,
      balance: a.balance,
      name: a.name || a.acc
    }));
    res.json({ accounts });
  } catch (e) {
    res.status(500).json({ error: 'Помилка підключення до ПриватБанку: ' + e.message });
  }
});

// ПриватБанк — синхронізація транзакцій
router.post('/privatbank/sync', auth, async (req, res) => {
  try {
    const intResult = await pool.query(
      'SELECT token, account_id FROM integrations WHERE user_id=$1 AND provider=$2 AND enabled=true',
      [req.userId, 'privatbank']
    );
    if (!intResult.rows.length) return res.status(400).json({ error: 'ПриватБанк не підключено' });
    const { token, account_id } = intResult.rows[0];

    const now = new Date();
    const from = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const fmtD = d => `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`;

    const url = `https://acp.privatbank.ua/api/statements/transactions?acc=${encodeURIComponent(account_id)}&startDate=${fmtD(from)}&endDate=${fmtD(now)}&limit=100`;
    const data = await httpsGet(url, { 'token': token, 'Content-Type': 'application/json' });

    if (data.status !== 'OK') return res.status(400).json({ error: data.message || 'Помилка API ПриватБанку' });

    let added = 0;
    for (const tx of (data.data || [])) {
      const amount = parseFloat(tx.BPL_SUM || 0);
      const isIncome = tx.BPL_DEBET_CREDIT === 'C';
      const dateParts = (tx.BPL_DAT_OD || '').split('-');
      const txDate = dateParts.length === 3
        ? new Date(`${dateParts[2]}-${dateParts[1]}-${dateParts[0]}T${tx.BPL_TIME || '00:00:00'}`)
        : new Date();
      const date = txDate.toISOString().split('T')[0];
      const description = tx.BPL_OSND || '';
      const txId = 'privat_' + (tx.BPL_NUM_DOC || tx.BPL_DAT_OD + '_' + amount);

      if (isIncome) {
        await pool.query(
          `INSERT INTO incomes (user_id, amount, type, source, description, date, transaction_time, bank_tx_id)
           VALUES ($1,$2,'Некласифіковано','ПриватБанк',$3,$4,$5,$6)
           ON CONFLICT (bank_tx_id) DO NOTHING`,
          [req.userId, amount, description, date, txDate, txId]
        );
      } else {
        await pool.query(
          `INSERT INTO expenses (user_id, amount, category, source, description, date, transaction_time, bank_tx_id)
           VALUES ($1,$2,'Некласифіковано','ПриватБанк',$3,$4,$5,$6)
           ON CONFLICT (bank_tx_id) DO NOTHING`,
          [req.userId, amount, description, date, txDate, txId]
        );
      }
      added++;
    }

    await pool.query('UPDATE integrations SET last_sync=NOW() WHERE user_id=$1 AND provider=$2', [req.userId, 'privatbank']);
    res.json({ success: true, synced: added });
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
      const txDate = new Date(tx.time * 1000);
      const date = txDate.toISOString().split('T')[0];
      const description = tx.description || '';
      if (amount > 0) {
        await pool.query(
          `INSERT INTO incomes (user_id, amount, type, source, description, date, transaction_time, bank_tx_id)
           VALUES ($1,$2,'Некласифіковано','Monobank',$3,$4,$5,$6)
           ON CONFLICT (bank_tx_id) DO NOTHING`,
          [req.userId, amount, description, date, txDate, tx.id]
        );
      } else {
        await pool.query(
          `INSERT INTO expenses (user_id, amount, category, source, description, date, transaction_time, bank_tx_id)
           VALUES ($1,$2,'Некласифіковано','Monobank',$3,$4,$5,$6)
           ON CONFLICT (bank_tx_id) DO NOTHING`,
          [req.userId, Math.abs(amount), description, date, txDate, tx.id]
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
