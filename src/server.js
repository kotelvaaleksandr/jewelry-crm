const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

require('./db').query(`
  ALTER TABLE incomes ADD COLUMN IF NOT EXISTS source VARCHAR(100);
  ALTER TABLE expenses ADD COLUMN IF NOT EXISTS source VARCHAR(100);
  ALTER TABLE incomes ADD COLUMN IF NOT EXISTS transaction_time TIMESTAMP;
  ALTER TABLE expenses ADD COLUMN IF NOT EXISTS transaction_time TIMESTAMP;
  CREATE TABLE IF NOT EXISTS income_types (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    UNIQUE(user_id, name)
  );
  CREATE TABLE IF NOT EXISTS expense_categories (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    UNIQUE(user_id, name)
  );
  UPDATE incomes SET source='Monobank' WHERE bank_tx_id IS NOT NULL AND source IS NULL;
  UPDATE expenses SET source='Monobank' WHERE bank_tx_id IS NOT NULL AND source IS NULL;
  CREATE TABLE IF NOT EXISTS plans (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    category VARCHAR(200) NOT NULL,
    category_type VARCHAR(20) NOT NULL,
    period VARCHAR(20) NOT NULL DEFAULT 'month',
    value_type VARCHAR(20) NOT NULL DEFAULT 'absolute',
    value NUMERIC(12,2),
    condition VARCHAR(10) DEFAULT 'gte',
    active BOOLEAN DEFAULT true
  );
  ALTER TABLE plans ADD COLUMN IF NOT EXISTS period VARCHAR(20) NOT NULL DEFAULT 'month';
  ALTER TABLE integrations ADD COLUMN IF NOT EXISTS login VARCHAR(200);
  ALTER TABLE integrations ADD COLUMN IF NOT EXISTS public_certificate TEXT;
  ALTER TABLE integrations ADD COLUMN IF NOT EXISTS jwt_token TEXT;
  ALTER TABLE integrations ADD COLUMN IF NOT EXISTS jwt_expiry TIMESTAMP;
  ALTER TABLE integrations ADD COLUMN IF NOT EXISTS novapay_client_id INTEGER;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100);
  ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name VARCHAR(100);
  ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(30);
  ALTER TABLE users ADD COLUMN IF NOT EXISTS internal_keywords TEXT DEFAULT '';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS expense_rules TEXT DEFAULT '[]';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS income_rules TEXT DEFAULT '[]';
  ALTER TABLE plans ADD COLUMN IF NOT EXISTS value_type VARCHAR(20) NOT NULL DEFAULT 'absolute';
  ALTER TABLE plans ADD COLUMN IF NOT EXISTS condition VARCHAR(10) DEFAULT 'gte';
  CREATE TABLE IF NOT EXISTS regular_expenses (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    amount NUMERIC(12,2) NOT NULL,
    period VARCHAR(20) NOT NULL,
    pay_day INTEGER,
    pay_month INTEGER,
    pay_date DATE,
    created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'none',
    amount NUMERIC(10,2) NOT NULL DEFAULT 299,
    order_id VARCHAR(100),
    rectoken VARCHAR(255),
    next_billing_date DATE,
    last_payment_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS payment_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    order_id VARCHAR(100),
    status VARCHAR(30),
    amount NUMERIC(10,2),
    raw_data JSONB,
    created_at TIMESTAMP DEFAULT NOW()
  );
`).catch(e => console.error('Auto-migration error:', e.message));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/finances'));
app.use('/api/integrations', require('./routes/integrations'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/integrations/novapay', require('./routes/novapay'));

// Щоденна перевірка підписок на списання (раз на годину)
setInterval(() => {
  require('./routes/payment').runBillingCheck().catch(e => console.error('Billing check error:', e.message));
}, 60 * 60 * 1000);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Saldo працює' });
});

app.get('/api/server-ip', (req, res) => {
  const https = require('https');
  https.get('https://api.ipify.org?format=json', r => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => res.json(JSON.parse(d)));
  }).on('error', e => res.json({ error: e.message }));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущено на порту ${PORT}`);
});
