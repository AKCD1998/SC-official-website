const crypto = require('node:crypto');
const BAHT_PER_POINT = 25;
const MAX_AMOUNT = 10000000;

function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }
function condition(raw) {
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { throw invalid('Invalid condition_json.'); } }
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid('condition_json must be an object.');
  return raw;
}
function validatePromotion(input) {
  const name = String(input.name || '').trim();
  const type = String(input.type || '');
  const value = Number(input.value);
  const rules = condition(input.condition_json);
  if (!name || name.length > 255) throw invalid('name must contain 1–255 characters.');
  if (!['multiplier', 'fixed_bonus', 'threshold'].includes(type)) throw invalid('Unsupported promotion type.');
  if (!Number.isFinite(value) || value < 0 || value > (type === 'multiplier' ? 100 : 1000000)) throw invalid('Invalid promotion value.');
  if (Object.keys(rules).some(k => !['minimum_spend', 'bonus_points', 'branch_codes'].includes(k))) throw invalid('Unsupported promotion condition.');
  if (rules.minimum_spend != null && (!Number.isFinite(Number(rules.minimum_spend)) || Number(rules.minimum_spend) < 0 || Number(rules.minimum_spend) > MAX_AMOUNT)) throw invalid('Invalid minimum_spend.');
  if (rules.bonus_points != null && (!Number.isSafeInteger(Number(rules.bonus_points)) || Number(rules.bonus_points) < 0 || Number(rules.bonus_points) > 1000000)) throw invalid('Invalid bonus_points.');
  if (rules.branch_codes != null && (!Array.isArray(rules.branch_codes) || !rules.branch_codes.length || rules.branch_codes.length > 100 || rules.branch_codes.some(b => typeof b !== 'string' || !/^[A-Za-z0-9_-]{1,20}$/.test(b)))) throw invalid('Invalid branch_codes.');
  const starts = input.starts_at || null, ends = input.ends_at || null;
  if ((starts && !Number.isFinite(Date.parse(starts))) || (ends && !Number.isFinite(Date.parse(ends))) || (starts && ends && Date.parse(ends) <= Date.parse(starts))) throw invalid('Invalid promotion dates.');
  if (input.is_active !== undefined && typeof input.is_active !== 'boolean') throw invalid('is_active must be boolean.');
  return { name, type, value, condition_json: rules, starts_at: starts, ends_at: ends, is_active: input.is_active ?? true };
}
async function getActivePromotions(db, branchCode = '') {
  const { rows } = await db.query(`SELECT id, name, type, value, condition_json, starts_at, ends_at, updated_at
    FROM promotions WHERE is_active = TRUE
    AND (starts_at IS NULL OR starts_at <= NOW()) AND (ends_at IS NULL OR ends_at > NOW())
    ORDER BY starts_at ASC NULLS FIRST, created_at ASC, id ASC`);
  const branch = String(branchCode || '').trim().toUpperCase();
  return rows.map(r => ({ ...r, value: Number(r.value), condition_json: condition(r.condition_json) }))
    .filter(r => !r.condition_json.branch_codes || r.condition_json.branch_codes.some(b => b.toUpperCase() === branch));
}
function quotePoints(totalAmount, promotions) {
  const amount = Number(totalAmount);
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_AMOUNT) throw invalid('Invalid eligible amount.');
  const basePoints = Math.floor(Math.round(amount * 100) / (BAHT_PER_POINT * 100));
  let points = basePoints;
  const appliedPromotions = [];
  for (const raw of promotions) {
    if (amount === 0) break;
    const p = { ...raw, ...validatePromotion(raw) };
    if (amount < Number(p.condition_json.minimum_spend || 0)) continue;
    const before = points;
    if (p.type === 'multiplier') points = Math.floor(points * p.value);
    else points += Math.floor(Number(p.condition_json.bonus_points ?? p.value));
    if (!Number.isSafeInteger(points) || points > 2147483647) throw invalid('Promotion award exceeds supported points.');
    appliedPromotions.push({ ...raw, pointsBefore: before, pointsAfter: points });
  }
  return { bahtPerPoint: BAHT_PER_POINT, basePoints, awardedPoints: points, appliedPromotions,
    revision: crypto.createHash('sha256').update(JSON.stringify(promotions)).digest('hex') };
}
function receiptEligibleAmount(items) {
  if (!Array.isArray(items) || !items.length || items.length > 1000) throw invalid('Receipt items are required (maximum 1000).');
  let cents = 0;
  for (const item of items) {
    if (!item || !Number.isFinite(Number(item.lineTotal)) || Number(item.lineTotal) < 0 || Number(item.lineTotal) > MAX_AMOUNT || !Number.isFinite(Number(item.qty)) || Number(item.qty) <= 0 || !Number.isFinite(Number(item.unitPrice)) || Number(item.unitPrice) < 0) throw invalid('Invalid receipt line.');
    if (!String(item.productName || '').startsWith('เภสัช')) cents += Math.round(Number(item.lineTotal) * 100);
  }
  if (cents > MAX_AMOUNT * 100) throw invalid('Receipt amount exceeds limit.');
  return cents / 100;
}
module.exports = { BAHT_PER_POINT, MAX_AMOUNT, validatePromotion, getActivePromotions, quotePoints, receiptEligibleAmount };
