const express = require('express');
const https = require('https');
const xml2js = require('xml2js');
const pool = require('../db');
const auth = require('../middleware/auth');
const { getUserKeywords, matchesKeywords } = require('../helpers/keywords');

const router = express.Router();

const NOVAPAY_ENDPOINT = 'business.novapay.ua';
const NOVAPAY_PATH = '/Services/ClientAPIService.svc';

// --- SOAP helper ---
function soapRequest(methodName, body) {
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <soapenv:Header/>
  <soapenv:Body>${body}</soapenv:Body>
</soapenv:Envelope>`;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: NOVAPAY_ENDPOINT,
      path: NOVAPAY_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml;charset=utf-8',
        'Content-Length': Buffer.byteLength(envelope, 'utf8'),
        'SOAPAction': `http://tempuri.org/IClientAPIService/${methodName}`
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log(`NovaPay [${methodName}] status=${res.statusCode} body=${data.substring(0, 500)}`);
        resolve(data);
      });
    });
    req.on('error', e => { console.error(`NovaPay SOAP error:`, e.message); reject(e); });
    req.write(envelope);
    req.end();
  });
}

async function parseXml(str) {
  return xml2js.parseStringPromise(str, { explicitArray: false, ignoreAttrs: false, tagNameProcessors: [xml2js.processors.stripPrefix] });
}

// Знайти результат у parsed об'єкті (stripPrefix прибирає ns-префікси)
function extractResult(parsed, methodName) {
  const body = parsed?.Envelope?.Body;
  if (!body) return null;
  const respKey = Object.keys(body).find(k => k.includes(methodName + 'Response') || k.includes('Response'));
  if (!respKey) return null;
  const resp = body[respKey];
  const resKey = Object.keys(resp).find(k => k.includes('Result'));
  return resKey ? resp[resKey] : null;
}

// Отримати JWT (з ротацією refresh_token)
async function authenticate(userId) {
  const row = await pool.query(
    'SELECT login, token AS refresh_token, public_certificate FROM integrations WHERE user_id=$1 AND provider=$2',
    [userId, 'novapay']
  );
  if (!row.rows.length) throw new Error('NovaPay не підключено');
  const { login, refresh_token, public_certificate } = row.rows[0];
  if (!login || !refresh_token || !public_certificate) throw new Error('Невистачає даних для авторизації NovaPay');

  const body = `<tem:UserAuthenticationJWT>
    <tem:request>
      <tem:request_ref></tem:request_ref>
      <tem:refresh_token>${escapeXml(refresh_token)}</tem:refresh_token>
      <tem:login>${escapeXml(login)}</tem:login>
      <tem:public_certificate>${escapeXml(public_certificate)}</tem:public_certificate>
    </tem:request>
  </tem:UserAuthenticationJWT>`;

  const xml = await soapRequest('UserAuthenticationJWT', body);
  let parsed;
  try { parsed = await parseXml(xml); } catch(e) { throw new Error('XML parse error: ' + e.message + ' | raw: ' + xml.substring(0, 200)); }

  const result = extractResult(parsed, 'UserAuthenticationJWT');
  console.log('NovaPay auth result:', JSON.stringify(result).substring(0, 300));

  if (!result || result.result !== 'ok') {
    throw new Error('NovaPay auth: ' + (result?.result || JSON.stringify(result) || 'порожня відповідь'));
  }

  await pool.query(
    `UPDATE integrations SET token=$1, public_certificate=$2, jwt_token=$3, jwt_expiry=$4
     WHERE user_id=$5 AND provider='novapay'`,
    [result.refresh_token || refresh_token, result.public_certificate || public_certificate,
     result.jwt, result.expiration ? new Date(result.expiration) : null, userId]
  );

  return result.jwt;
}

function escapeXml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// In-memory lock: якщо auth вже виконується для цього userId — чекаємо, не запускаємо нову
const authLocks = {};

async function getJwt(userId) {
  const row = await pool.query(
    'SELECT jwt_token, jwt_expiry FROM integrations WHERE user_id=$1 AND provider=$2',
    [userId, 'novapay']
  );
  const { jwt_token, jwt_expiry } = row.rows[0] || {};
  if (jwt_token && jwt_expiry && new Date(jwt_expiry) > new Date(Date.now() + 60000)) return jwt_token;

  // Якщо вже є активний auth для цього userId — приєднуємось до нього
  if (authLocks[userId]) return authLocks[userId];

  authLocks[userId] = (async () => {
    try {
      return await authenticate(userId);
    } catch (e) {
      // Одна автоматична повторна спроба через 2 сек
      console.log('NovaPay auth failed, retrying in 2s...', e.message);
      await new Promise(r => setTimeout(r, 2000));
      return await authenticate(userId);
    } finally {
      delete authLocks[userId];
    }
  })();

  return authLocks[userId];
}

// --- Підключення ---
router.post('/connect', auth, async (req, res) => {
  const { login, refresh_token, public_certificate } = req.body;
  if (!login || !refresh_token || !public_certificate) {
    return res.status(400).json({ error: 'Потрібні: login, refresh_token, public_certificate' });
  }
  try {
    await pool.query(
      `INSERT INTO integrations (user_id, provider, token, account_id, enabled, login, public_certificate)
       VALUES ($1,'novapay',$2,null,false,$3,$4)
       ON CONFLICT (user_id, provider) DO UPDATE SET token=$2, login=$3, public_certificate=$4, enabled=false`,
      [req.userId, refresh_token, login, public_certificate]
    );

    const jwt = await authenticate(req.userId);

    const clientsXml = await soapRequest('GetClientsList', `<tem:GetClientsList>
      <tem:request>
        <tem:request_ref></tem:request_ref>
        <tem:jwt>${escapeXml(jwt)}</tem:jwt>
      </tem:request>
    </tem:GetClientsList>`);

    const parsed = await parseXml(clientsXml);
    const result = extractResult(parsed, 'GetClientsList');
    console.log('GetClientsList result:', JSON.stringify(result).substring(0, 300));

    if (!result || result.result !== 'ok') throw new Error('Помилка GetClientsList: ' + (result?.result || JSON.stringify(result)));

    let clients = result.clients?.Clients || result.clients?.clients || [];
    if (!Array.isArray(clients)) clients = clients ? [clients] : [];

    res.json({ clients: clients.map(c => ({ id: c.id, name: c.name, statecode: c.statecode })) });
  } catch (e) {
    console.error('NovaPay connect error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// --- Отримати рахунки ---
router.post('/accounts', auth, async (req, res) => {
  const { client_id } = req.body;
  if (!client_id) return res.status(400).json({ error: 'client_id обовязковий' });
  try {
    const jwt = await getJwt(req.userId);
    const xml = await soapRequest('GetAccountsList', `<tem:GetAccountsList>
      <tem:request>
        <tem:request_ref></tem:request_ref>
        <tem:jwt>${escapeXml(jwt)}</tem:jwt>
        <tem:client_id>${client_id}</tem:client_id>
      </tem:request>
    </tem:GetAccountsList>`);

    const parsed = await parseXml(xml);
    const result = extractResult(parsed, 'GetAccountsList');
    console.log('GetAccountsList result:', JSON.stringify(result).substring(0, 300));
    if (!result || result.result !== 'ok') throw new Error('GetAccountsList: ' + (result?.result || JSON.stringify(result)));

    let accounts = result.accounts?.Accounts || result.accounts?.accounts || [];
    if (!Array.isArray(accounts)) accounts = accounts ? [accounts] : [];

    res.json({ accounts: accounts.filter(a => a.statuscode === 'Active' || a.status === '1').map(a => ({ id: a.id, iban: a.IBAN || a.iban, name: a.name, currency: a.currency })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Активувати ---
router.post('/activate', auth, async (req, res) => {
  const { client_id, account_id } = req.body;
  if (!client_id || !account_id) return res.status(400).json({ error: 'client_id і account_id обовязкові' });
  try {
    await pool.query(
      `UPDATE integrations SET novapay_client_id=$1, account_id=$2, enabled=true WHERE user_id=$3 AND provider='novapay'`,
      [client_id, account_id, req.userId]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Синхронізація ---
router.post('/sync', auth, async (req, res) => {
  try {
    const intRow = await pool.query(
      'SELECT account_id, novapay_client_id, enabled FROM integrations WHERE user_id=$1 AND provider=$2',
      [req.userId, 'novapay']
    );
    if (!intRow.rows.length || !intRow.rows[0].enabled) return res.status(400).json({ error: 'NovaPay не підключено' });
    const { account_id } = intRow.rows[0];

    const jwt = await getJwt(req.userId);
    const now = new Date();
    const from = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const fmtD = d => `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;

    const xml = await soapRequest('GetPaymentsList', `<tem:GetPaymentsList>
      <tem:request>
        <tem:request_ref></tem:request_ref>
        <tem:jwt>${escapeXml(jwt)}</tem:jwt>
        <tem:account_id>${account_id}</tem:account_id>
        <tem:date_from>${fmtD(from)}</tem:date_from>
        <tem:date_to>${fmtD(now)}</tem:date_to>
        <tem:date_type>0</tem:date_type>
      </tem:request>
    </tem:GetPaymentsList>`);

    const parsed = await parseXml(xml);
    const result = extractResult(parsed, 'GetPaymentsList');
    if (!result || result.result !== 'ok') return res.status(400).json({ error: 'GetPaymentsList: ' + (result?.result || JSON.stringify(result)) });

    const paymentsXml = result.payments;
    if (!paymentsXml || paymentsXml.trim() === '') return res.json({ success: true, synced: 0 });

    const payParsed = await parseXml(paymentsXml);
    let docs = payParsed?.Payments?.Docs || [];
    if (!Array.isArray(docs)) docs = docs ? [docs] : [];

    const conducted = docs.filter(d => d.StatusDocumentId === '8' || d.StatusDocumentId === '9');
    const keywords = await getUserKeywords(req.userId);
    // Гарантуємо наявність типу в довіднику
    await pool.query(
      `INSERT INTO income_types (user_id, name) VALUES ($1, 'Наложений платіж') ON CONFLICT (user_id, name) DO NOTHING`,
      [req.userId]
    );
    let added = 0;
    for (const doc of conducted) {
      const amount = parseFloat(doc?.$ ?.Amount || doc.Amount || 0);
      const isIncome = doc.PaymentType === 'Credit';
      const dateStr = doc.DayDate || doc.OrgDate || '';
      let txDate = new Date();
      if (dateStr) { const [day, month, year] = dateStr.split('.'); txDate = new Date(`${year}-${month}-${day}`); }
      const date = txDate.toISOString().split('T')[0];
      const description = doc.Purpose || '';
      const txId = 'novapay_' + (doc.Code || date + '_' + amount);
      const isInternal = matchesKeywords(description, keywords);
      const isNovapayInvoice = description.toLowerCase().includes('переказ коштів по платежам, прийнятим від населення');
      let incomeType = 'Некласифіковано';
      if (isInternal) incomeType = 'Внутрішній переказ';
      else if (isNovapayInvoice) incomeType = 'Наложений платіж';

      if (isIncome) {
        await pool.query(`INSERT INTO incomes (user_id,amount,type,source,description,date,transaction_time,bank_tx_id) VALUES ($1,$2,$3,'NovaPay',$4,$5,$6,$7) ON CONFLICT (bank_tx_id) DO NOTHING`,
          [req.userId, amount, incomeType, description, date, txDate, txId]);
      } else {
        await pool.query(`INSERT INTO expenses (user_id,amount,category,source,description,date,transaction_time,bank_tx_id) VALUES ($1,$2,$3,'NovaPay',$4,$5,$6,$7) ON CONFLICT (bank_tx_id) DO NOTHING`,
          [req.userId, amount, isInternal ? 'Внутрішній переказ' : 'Некласифіковано', description, date, txDate, txId]);
      }
      added++;
    }
    await pool.query('UPDATE integrations SET last_sync=NOW() WHERE user_id=$1 AND provider=$2', [req.userId, 'novapay']);
    res.json({ success: true, synced: added });
  } catch (e) {
    console.error('NovaPay sync error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Перекласифікувати існуючі NovaPay доходи як "Наложений платіж"
router.post('/reclassify', auth, async (req, res) => {
  try {
    // Переконуємось що тип існує в income_types
    await pool.query(
      `INSERT INTO income_types (user_id, name) VALUES ($1, 'Наложений платіж') ON CONFLICT (user_id, name) DO NOTHING`,
      [req.userId]
    );

    const result = await pool.query(
      `UPDATE incomes SET type='Наложений платіж'
       WHERE user_id=$1
         AND type IS DISTINCT FROM 'Внутрішній переказ'
         AND (description ILIKE '%переказ коштів по платежам%' OR description ILIKE '%прийнятим від населення%')`,
      [req.userId]
    );
    res.json({ updated: result.rowCount || 0 });
  } catch (e) {
    console.error('NovaPay reclassify error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
