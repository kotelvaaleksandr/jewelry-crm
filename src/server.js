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
`).catch(e => console.error('Auto-migration error:', e.message));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/finances'));
app.use('/api/integrations', require('./routes/integrations'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Jewelry CRM працює' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущено на порту ${PORT}`);
});
