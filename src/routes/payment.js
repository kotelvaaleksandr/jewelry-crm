const express = require('express');
const crypto = require('crypto');
const https = require('https');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

const LIQPAY_PUBLIC_KEY = process.env.LIQPAY_PUBLIC_KEY;
const LIQPAY_PRIVATE_KEY = process.env.LIQPAY_PRIVATE_KEY;
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const PLAN_AMOUNT = 299; // ₴/міс — базовий тариф

function liqpaySign(dataStr) {
  return crypto.createHash('sha1').update(LIQPAY_PRIVATE_KEY + dataStr + LIQPAY_PRIVATE_KEY).digest('base64');
}

// Створити запит на підписку (рекурентний платіж)
router.post('/liqpay/checkout', auth, async (req, res) => {
  if (!LIQPAY_PUBLIC_KEY || !LIQPAY_PRIVATE_KEY) {
    return res.status(500).json({ error: 'LiqPay не налаштовано на сервері (відсутні ключі)' });
  }
  try {
    const userRes = await pool.query('SELECT email FROM users WHERE id=$1', [req.userId]);
    const email = userRes.rows[0]?.email || '';
    const orderId = `sub_${req.userId}_${Date.now()}`;

    const params = {
      version: 3,
      public_key: LIQPAY_PUBLIC_KEY,
      action: 'subscribe',
      amount: PLAN_AMOUNT,
      currency: 'UAH',
      description: 'Підписка Saldo — щомісячний платіж',
      order_id: orderId,
      subscribe: 1,
      subscribe_date_start: new Date().toISOString().slice(0, 19).replace('T', ' '),
      subscribe_periodicity: 'month',
      language: 'uk',
      sender_email: email,
      result_url: `${APP_URL}/?payment=success`,
      server_url: `${APP_URL}/api/payment/liqpay/callback`
    };

    const dataStr = Buffer.from(JSON.stringify(params)).toString('base64');
    const signature = liqpaySign(dataStr);

    await pool.query(
      `INSERT INTO subscriptions (user_id, status, amount, order_id)
       VALUES ($1, 'pending', $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET status='pending', amount=$2, order_id=$3, updated_at=NOW()`,
      [req.userId, PLAN_AMOUNT, orderId]
    );

    res.json({ data: dataStr, signature, checkout_url: 'https://www.liqpay.ua/api/3/checkout' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Callback від LiqPay (server-to-server, без auth)
router.post('/liqpay/callback', async (req, res) => {
  try {
    const { data, signature } = req.body;
    if (!data || !signature) return res.status(400).send('bad request');
    const expectedSign = liqpaySign(data);
    if (expectedSign !== signature) {
      console.error('LiqPay callback: invalid signature');
      return res.status(400).send('invalid signature');
    }
    const payload = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
    const orderId = payload.order_id;
    const userId = parseInt((orderId || '').split('_')[1]);
    if (!userId) return res.status(400).send('bad order_id');

    await pool.query(
      'INSERT INTO payment_log (user_id, order_id, status, amount, raw_data) VALUES ($1,$2,$3,$4,$5)',
      [userId, orderId, payload.status, payload.amount || null, payload]
    );

    if (payload.status === 'subscribed' || payload.status === 'success') {
      const next = new Date();
      next.setMonth(next.getMonth() + 1);
      await pool.query(
        `UPDATE subscriptions SET status='active', rectoken=$1, next_billing_date=$2, last_payment_date=NOW(), updated_at=NOW() WHERE user_id=$3`,
        [payload.rectoken_id || payload.token || null, next.toISOString().split('T')[0], userId]
      );
    } else if (payload.status === 'failure' || payload.status === 'error') {
      await pool.query(`UPDATE subscriptions SET status='failed', updated_at=NOW() WHERE user_id=$1`, [userId]);
    } else if (payload.status === 'unsubscribed') {
      await pool.query(`UPDATE subscriptions SET status='cancelled', updated_at=NOW() WHERE user_id=$1`, [userId]);
    }
    res.status(200).send('ok');
  } catch (e) {
    console.error('LiqPay callback error:', e.message);
    res.status(500).send('error');
  }
});

// Статус підписки поточного користувача
router.get('/status', auth, async (req, res) => {
  const result = await pool.query('SELECT status, amount, next_billing_date, last_payment_date FROM subscriptions WHERE user_id=$1', [req.userId]);
  res.json(result.rows[0] || { status: 'none' });
});

// Відміна підписки
router.post('/cancel', auth, async (req, res) => {
  try {
    const sub = await pool.query('SELECT rectoken FROM subscriptions WHERE user_id=$1', [req.userId]);
    const rectoken = sub.rows[0]?.rectoken;
    if (rectoken) {
      const params = { version: 3, public_key: LIQPAY_PUBLIC_KEY, action: 'unsubscribe', order_id: `unsub_${req.userId}_${Date.now()}` };
      const dataStr = Buffer.from(JSON.stringify(params)).toString('base64');
      const signature = liqpaySign(dataStr);
      await new Promise((resolve, reject) => {
        const body = `data=${encodeURIComponent(dataStr)}&signature=${encodeURIComponent(signature)}`;
        const r = https.request('https://www.liqpay.ua/api/request', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, resp => {
          let d = ''; resp.on('data', c => d += c); resp.on('end', () => resolve(d));
        });
        r.on('error', reject);
        r.write(body); r.end();
      });
    }
    await pool.query(`UPDATE subscriptions SET status='cancelled', updated_at=NOW() WHERE user_id=$1`, [req.userId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.runBillingCheck = async function () {
  // LiqPay сам списує по subscribe_periodicity, тут лише підтримуємо next_billing_date в актуальному стані
  const overdue = await pool.query(`SELECT user_id FROM subscriptions WHERE status='active' AND next_billing_date < NOW() - INTERVAL '3 days'`);
  for (const row of overdue.rows) {
    console.warn(`Підписка user_id=${row.user_id} простроченa більше 3 днів — перевірте статус в LiqPay`);
  }
};
