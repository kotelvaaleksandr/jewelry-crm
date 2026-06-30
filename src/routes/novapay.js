const express = require('express');
const https = require('https');
const xml2js = require('xml2js');
const pool = require('../db');
const auth = require('../middleware/auth');

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

// Кеш JWT
async function getJwt(userId) {
  const row = await pool.query(
    'SELECT jwt_token, jwt_expiry FROM integrations WHERE user_id=$1 AND provider=$2',
    [userId, 'novapay']
  );
  const { jwt_token, jwt_expiry } = row.rows[0] || {};
  if (jwt_token && jwt_expiry && new Date(jwt_expiry) > new Date(Date.now() + 60000)) return jwt_token;
  return authenticate(userId);
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
      if (isIncome) {
        await pool.query(`INSERT INTO incomes (user_id,amount,type,source,description,date,transaction_time,bank_tx_id) VALUES ($1,$2,'Некласифіковано','NovaPay',$3,$4,$5,$6) ON CONFLICT (bank_tx_id) DO NOTHING`,
          [req.userId, amount, description, date, txDate, txId]);
      } else {
        await pool.query(`INSERT INTO expenses (user_id,amount,category,source,description,date,transaction_time,bank_tx_id) VALUES ($1,$2,'Некласифіковано','NovaPay',$3,$4,$5,$6) ON CONFLICT (bank_tx_id) DO NOTHING`,
          [req.userId, amount, description, date, txDate, txId]);
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

module.exports = router;
