const pool = require('../db');

async function getUserKeywords(userId) {
  const r = await pool.query('SELECT internal_keywords FROM users WHERE id=$1', [userId]);
  const raw = r.rows[0]?.internal_keywords || '';
  return raw.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
}

async function getUserExpenseRules(userId) {
  const r = await pool.query('SELECT expense_rules FROM users WHERE id=$1', [userId]);
  try { return JSON.parse(r.rows[0]?.expense_rules || '[]').filter(r => r.keyword && r.category); } catch(e) { return []; }
}

function matchesKeywords(description, keywords) {
  if (!description || !keywords.length) return false;
  const lower = String(description).toLowerCase();
  return keywords.some(k => lower.includes(k));
}

// Повертає категорію з правил або null
function matchExpenseRule(description, rules) {
  if (!description || !rules.length) return null;
  const lower = String(description).toLowerCase();
  const match = rules.find(r => lower.includes(r.keyword.toLowerCase()));
  return match ? match.category : null;
}

module.exports = { getUserKeywords, getUserExpenseRules, matchesKeywords, matchExpenseRule };
