const express = require('express');
const https = require('https');
const pool = require('../db');
const auth = require('../middleware/auth');
const { getUserKeywords, getUserExpenseRules, getUserIncomeRules, matchesKeywords, matchExpenseRule, matchIncomeRule } = require('../helpers/keywords');

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
  const cleanToken = token.replace(/\s+/g, '');
  try {
    const data = await httpsGet('https://acp.privatbank.ua/api/statements/accounts', {
      'token': cleanToken,
      'Content-Type': 'application/json;charset=utf-8',
      'User-Agent': 'Saldo/1.0'
    });
    console.log('PrivatBank accounts response:', JSON.stringify(data).substring(0, 300));
    if (data.status !== 'SUCCESS') {
      return res.status(400).json({ error: `ПриватБанк API: ${data.message || data.status || JSON.stringify(data).substring(0, 200)}` });
    }
    const accounts = (data.accounts || data.data || []).map(a => ({
      id: a.acc,
      iban: a.acc,
      currency: a.currency || 'UAH',
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
    const cleanToken = token.replace(/\s+/g, '');

    const now = new Date();
    const from = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const fmtD = d => `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`;

    const url = `https://acp.privatbank.ua/api/statements/transactions?acc=${encodeURIComponent(account_id)}&startDate=${fmtD(from)}&endDate=${fmtD(now)}&limit=500`;
    console.log('PrivatBank sync URL:', url);
    const data = await httpsGet(url, { 'token': cleanToken, 'Content-Type': 'application/json;charset=utf-8', 'User-Agent': 'Saldo/1.0' });
    if (data.status !== 'SUCCESS') return res.status(400).json({ error: `ПриватБанк: ${data.message || data.errorDescription || JSON.stringify(data).substring(0, 200)}` });

    // Збираємо всі транзакції з пагінацією
    let allTx = data.transactions || [];
    let nextPageId = data.exist_next_page ? data.next_page_id : null;
    while (nextPageId) {
      const nextUrl = `https://acp.privatbank.ua/api/statements/transactions?acc=${encodeURIComponent(account_id)}&startDate=${fmtD(from)}&endDate=${fmtD(now)}&limit=500&followId=${nextPageId}`;
      const nextData = await httpsGet(nextUrl, { 'token': cleanToken, 'Content-Type': 'application/json;charset=utf-8', 'User-Agent': 'Saldo/1.0' });
      if (nextData.status !== 'SUCCESS') break;
      allTx = allTx.concat(nextData.transactions || []);
      nextPageId = nextData.exist_next_page ? nextData.next_page_id : null;
    }

    const keywords = await getUserKeywords(req.userId);
    const expRules = await getUserExpenseRules(req.userId);
    const incRules = await getUserIncomeRules(req.userId);
    let added = 0;
    for (const tx of allTx) {
      const amount = parseFloat(tx.SUM || 0);
      const isIncome = tx.TRANTYPE === 'C';
      let txDate;
      try {
        if (tx.DAT_OD) {
          const [d, m, y] = tx.DAT_OD.split('.');
          const timeStr = tx.TIM_P || '00:00';
          txDate = new Date(`${y}-${m}-${d}T${timeStr}:00`);
        } else {
          txDate = new Date();
        }
        if (isNaN(txDate.getTime())) txDate = new Date();
      } catch(e) { txDate = new Date(); }
      const date = txDate.toISOString().split('T')[0];
      const description = tx.OSND || tx.AUT_CNTR_NAM || '';
      const txId = 'privat_' + (tx.TECHNICAL_TRANSACTION_ID || tx.REF || (date + '_' + amount));
      const isInternal = matchesKeywords(description, keywords);

      if (isIncome) {
        const incType = isInternal ? 'Внутрішній переказ' : (matchIncomeRule(description, incRules) || 'Некласифіковано');
        await pool.query(
          `INSERT INTO incomes (user_id, amount, type, source, description, date, transaction_time, bank_tx_id)
           VALUES ($1,$2,$3,'ПриватБанк',$4,$5,$6,$7)
           ON CONFLICT (bank_tx_id) DO NOTHING`,
          [req.userId, amount, incType, description, date, txDate, txId]
        );
      } else {
        const expCat = isInternal ? 'Внутрішній переказ' : (matchExpenseRule(description, expRules) || 'Некласифіковано');
        await pool.query(
          `INSERT INTO expenses (user_id, amount, category, source, description, date, transaction_time, bank_tx_id)
           VALUES ($1,$2,$3,'ПриватБанк',$4,$5,$6,$7)
           ON CONFLICT (bank_tx_id) DO NOTHING`,
          [req.userId, amount, expCat, description, date, txDate, txId]
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

    const keywords = await getUserKeywords(req.userId);
    const expRules = await getUserExpenseRules(req.userId);
    const incRules = await getUserIncomeRules(req.userId);
    let added = 0;
    for (const tx of data) {
      const amount = tx.amount / 100;
      const txDate = new Date(tx.time * 1000);
      const date = txDate.toISOString().split('T')[0];
      const description = tx.description || '';
      const isInternal = matchesKeywords(description, keywords);
      if (amount > 0) {
        const incType = isInternal ? 'Внутрішній переказ' : (matchIncomeRule(description, incRules) || 'Некласифіковано');
        await pool.query(
          `INSERT INTO incomes (user_id, amount, type, source, description, date, transaction_time, bank_tx_id)
           VALUES ($1,$2,$3,'Monobank',$4,$5,$6,$7)
           ON CONFLICT (bank_tx_id) DO NOTHING`,
          [req.userId, amount, incType, description, date, txDate, tx.id]
        );
      } else {
        const expCat = isInternal ? 'Внутрішній переказ' : (matchExpenseRule(description, expRules) || 'Некласифіковано');
        await pool.query(
          `INSERT INTO expenses (user_id, amount, category, source, description, date, transaction_time, bank_tx_id)
           VALUES ($1,$2,$3,'Monobank',$4,$5,$6,$7)
           ON CONFLICT (bank_tx_id) DO NOTHING`,
          [req.userId, Math.abs(amount), expCat, description, date, txDate, tx.id]
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
