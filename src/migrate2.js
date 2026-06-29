const pool = require('./db');

const sql = `
  ALTER TABLE incomes ADD COLUMN IF NOT EXISTS source VARCHAR(100);
  ALTER TABLE expenses ADD COLUMN IF NOT EXISTS source VARCHAR(100);

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
`;

pool.query(sql)
  .then(() => { console.log('Migration 2 done'); process.exit(0); })
  .catch(e => { console.error('Migration 2 error:', e.message); process.exit(1); });
