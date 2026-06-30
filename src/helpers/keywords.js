const pool = require('../db');

async function getUserKeywords(userId) {
  const r = await pool.query('SELECT internal_keywords FROM users WHERE id=$1', [userId]);
  const raw = r.rows[0]?.internal_keywords || '';
  return raw.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
}

function matchesKeywords(description, keywords) {
  if (!description || !keywords.length) return false;
  const lower = String(description).toLowerCase();
  return keywords.some(k => lower.includes(k));
}

module.exports = { getUserKeywords, matchesKeywords };
