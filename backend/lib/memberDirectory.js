const pool = require('../db');
const { parseHistoryCursor } = require('./purchaseHistory');

function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }
function integer(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || Number(value) > maximum) throw invalid('Invalid pagination.');
  return Number(value);
}
function directoryQuery(query) {
  if (Object.keys(query).some(key => !['search', 'page', 'limit'].includes(key))) throw invalid('Invalid query.');
  if (query.search !== undefined && (typeof query.search !== 'string' || query.search.length > 100)) throw invalid('Invalid search.');
  return { search: (query.search || '').trim(), page: integer(query.page, 1, 100000), limit: integer(query.limit, 25, 100) };
}
function historyQuery(id, query) {
  if (Object.keys(query).some(key => !['limit', 'cursor'].includes(key))) throw invalid('Invalid query.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw invalid('Invalid member ID.');
  const limit = integer(query.limit, 25, 100);
  parseHistoryCursor(query.cursor);
  return { limit };
}
async function listMembers(query) {
  const { search, page, limit } = directoryQuery(query);
  const pattern = '%' + search.replace(/[\\%_]/g, '\\$&') + '%';
  const where = `FROM users u JOIN member_profiles m ON m.user_id = u.id
    WHERE ($1 = '' OR u.full_name ILIKE $2 OR u.phone_number ILIKE $2 OR m.member_code ILIKE $2)`;
  // One statement keeps the count and page in the same database snapshot.
  const { rows } = await pool.query(`WITH matching AS (
    SELECT u.id, u.full_name, u.phone_number, m.member_code, m.is_active, m.created_at ${where}
  ), paged AS (
    SELECT * FROM matching ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4
  ) SELECT (SELECT COUNT(*)::int FROM matching) AS total,
    COALESCE((SELECT json_agg(p ORDER BY p.created_at DESC, p.id DESC) FROM paged p), '[]'::json) AS members`,
    [search, pattern, limit, (page - 1) * limit]);
  const result = rows[0];
  return { ok: true, page, limit, total: Number(result.total), members: result.members.map(row => ({
    id: row.id, memberCode: row.member_code, name: row.full_name, phone: row.phone_number,
    registeredAt: row.created_at, isActive: row.is_active,
  })) };
}
module.exports = { listMembers, directoryQuery, historyQuery };
