'use strict';

const crypto = require('node:crypto');
const pool = require('../db');
const { enabled } = require('./adaMemberMirror');
const SOURCE = 'hq000/AdaAcc';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const messages = {
  INVALID_LINK: 'ข้อมูลการผูกไม่ถูกต้อง กรุณาโหลดรายการใหม่',
  LINK_UNAVAILABLE: 'ระบบเลือกรหัส Ada ยังไม่พร้อมใช้งาน',
  MEMBER_NOT_FOUND: 'ไม่พบสมาชิกที่เปิดใช้งานใน SCCRM',
  MEMBER_ALREADY_LINKED: 'สมาชิกนี้ผูกกับรหัส Ada แล้ว กรุณาโหลดรายการใหม่',
  ADA_ALREADY_LINKED: 'รหัส Ada นี้ผูกกับสมาชิกคนอื่นแล้ว',
  PHONE_CHANGED: 'เบอร์โทรหรือข้อมูลลูกค้าเปลี่ยนแล้ว กรุณาโหลดรายการและตรวจสอบอีกครั้ง',
  OPTIONS_EXPIRED: 'รายการนี้หมดอายุแล้ว กรุณาโหลดรายการใหม่',
  BILL_OWNER_CONFLICT: 'มีบิลของรหัส Ada นี้ผูกกับสมาชิกอื่นอยู่ ต้องตรวจสอบก่อนผูก',
};
function fail(code, status = 409) { throw Object.assign(new Error(messages[code]), { status, code }); }
function ready() {
  if (!enabled() || String(process.env.SC_OFFICIAL_ADA_LINK_ADMIN_TOKEN || '').length < 32) fail('LINK_UNAVAILABLE', 503);
}
function phone(value) { return String(value || '').replace(/\D/g, '').replace(/^66(?=\d{9}$)/, '0'); }
// Matches the create-only native procedure's existing-phone check, including
// a Thai international number or multiple numbers in the same native field.
const nativePhone = alias => `REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${alias}.phone,''),' ',''),'-',''),'(',''),')','')`;
const matches = (alias, parameter) => `(${nativePhone(alias)} LIKE '%'||${parameter}||'%' OR ${nativePhone(alias)} LIKE '%66'||substring(${parameter} FROM 2)||'%')`;
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function signature(value) { return crypto.createHmac('sha256', process.env.SC_OFFICIAL_ADA_LINK_ADMIN_TOKEN).update(value).digest('base64url'); }
function token(member, candidate, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ v: 1, memberId: member.id, adaCode: candidate.ada_code,
    memberHash: digest([member.full_name, member.phone_number]), candidateHash: candidate.payload_hash,
    expires: now + 10 * 60 * 1000 })).toString('base64url');
  return payload + '.' + signature(payload);
}
function verifyToken(raw, memberId, adaCode) {
  if (typeof raw !== 'string' || raw.length > 2048) fail('INVALID_LINK', 400);
  const parts = raw.split('.');
  if (parts.length !== 2) fail('INVALID_LINK', 400);
  const actual = Buffer.from(parts[1]), expected = Buffer.from(signature(parts[0]));
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) fail('INVALID_LINK', 400);
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { fail('INVALID_LINK', 400); }
  if (payload.v !== 1 || payload.memberId !== memberId || payload.adaCode !== adaCode || !Number.isFinite(payload.expires)) fail('INVALID_LINK', 400);
  return payload;
}
async function member(db, id, lock = false) {
  const row = (await db.query(`SELECT u.id,u.full_name,u.phone_number,m.member_code
    FROM public.users u JOIN public.member_profiles m ON m.user_id=u.id
    WHERE u.id=$1::uuid AND m.is_active=true ${lock ? 'FOR UPDATE OF u,m' : ''}`, [id])).rows[0];
  if (!row) fail('MEMBER_NOT_FOUND', 404);
  return row;
}
const publicMember = m => ({ id: m.id, name: m.full_name, phone: m.phone_number, memberCode: m.member_code });

async function pendingLinks(query = {}) {
  ready();
  if (Object.keys(query).some(k => !['page', 'limit'].includes(k))) fail('INVALID_LINK', 400);
  const page = query.page === undefined ? 1 : Number(query.page), limit = query.limit === undefined ? 25 : Number(query.limit);
  if (![page, limit].every(Number.isSafeInteger) || page < 1 || page > 100000 || limit < 1 || limit > 100 ||
      [query.page, query.limit].some(v => v !== undefined && (typeof v !== 'string' || !/^[1-9]\d*$/.test(v)))) fail('INVALID_LINK', 400);
  const normalized = `regexp_replace(COALESCE(u.phone_number,''),'[^0-9]','','g')`;
  const localPhone = `(CASE WHEN ${normalized} ~ '^66[0-9]{9}$' THEN '0'||substring(${normalized} FROM 3) ELSE ${normalized} END)`;
  const { rows } = await pool.query(`WITH pending AS (
    SELECT u.id,u.full_name,u.phone_number,m.member_code,
      (SELECT count(*)::int FROM ada_history.customers c WHERE c.source_id=$1 AND c.ada_code<>'0' AND ${matches('c', localPhone)}) candidate_count
    FROM public.users u JOIN public.member_profiles m ON m.user_id=u.id
    WHERE m.is_active=true AND ${localPhone} ~ '^0[0-9]{9}$'
      AND NOT EXISTS(SELECT 1 FROM ada_history.member_links l WHERE l.member_id=u.id)
  ), matching AS (SELECT * FROM pending WHERE candidate_count>0), paged AS (
    SELECT * FROM matching ORDER BY full_name,id LIMIT $2 OFFSET $3
  ) SELECT (SELECT count(*)::int FROM matching) total,
    COALESCE((SELECT json_agg(p ORDER BY p.full_name,p.id) FROM paged p),'[]'::json) members`, [SOURCE, limit, (page - 1) * limit]);
  return { ok: true, page, limit, total: rows[0].total, members: rows[0].members.map(m => ({ ...publicMember(m), candidateCount: m.candidate_count })) };
}

async function linkOptions(id) {
  ready();
  if (!uuid.test(id)) fail('INVALID_LINK', 400);
  const m = await member(pool, id), local = phone(m.phone_number);
  const linked = (await pool.query('SELECT ada_code FROM ada_history.member_links WHERE member_id=$1 ORDER BY ada_code', [id])).rows.map(r => r.ada_code);
  const rows = /^0\d{9}$/.test(local) ? (await pool.query(`SELECT c.ada_code,c.name,c.phone,c.branch_code,c.active,c.payload_hash,
    l.member_id linked_member_id,u.full_name linked_member_name,
    (SELECT count(*)::int FROM ada_history.receipts r WHERE r.source_id=c.source_id AND r.customer_code=c.ada_code AND r.doc_type='1') sale_count,
    (SELECT count(*)::int FROM ada_history.receipts r WHERE r.source_id=c.source_id AND r.customer_code=c.ada_code AND r.doc_type='9') return_count,
    (SELECT max((r.sale_date+COALESCE(r.sale_time,'00:00:00'::time)) AT TIME ZONE 'Asia/Bangkok') FROM ada_history.receipts r WHERE r.source_id=c.source_id AND r.customer_code=c.ada_code AND r.doc_type='1') last_sale
    FROM ada_history.customers c LEFT JOIN ada_history.member_links l ON l.source_id=c.source_id AND l.ada_code=c.ada_code
    LEFT JOIN public.users u ON u.id=l.member_id
    WHERE c.source_id=$1 AND c.ada_code<>'0' AND ${matches('c', '$2')} ORDER BY c.ada_code LIMIT 101`, [SOURCE, local])).rows : [];
  if (rows.length > 100) fail('INVALID_LINK', 409);
  return { ok: true, member: publicMember(m), linkedCodes: linked, candidates: rows.map(c => ({
    adaCode: c.ada_code, name: c.name, phone: c.phone, branchCode: c.branch_code, isActive: c.active === '1',
    saleCount: c.sale_count, returnCount: c.return_count, lastSaleAt: c.last_sale,
    linkedMemberId: c.linked_member_id || null, linkedMemberName: c.linked_member_name || null,
    reviewToken: token(m, c),
  })) };
}

async function confirmLink(id, body) {
  ready();
  if (!uuid.test(id) || !body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(k => !['adaCode', 'reviewToken', 'actor'].includes(k)) ||
      typeof body.adaCode !== 'string' || !/^[A-Za-z0-9-]{1,20}$/.test(body.adaCode) || body.adaCode === '0' ||
      body.actor?.role !== 'admin' || typeof body.actor?.id !== 'string' || !/^[A-Za-z0-9_@.:-]{1,128}$/.test(body.actor.id)) fail('INVALID_LINK', 400);
  const signed = verifyToken(body.reviewToken, id, body.adaCode), client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='10s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['ada-link-member:' + id]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['ada-link-code:' + SOURCE + ':' + body.adaCode]);
    const m = await member(client, id, true);
    const existing = (await client.query('SELECT member_id,ada_code FROM ada_history.member_links WHERE (source_id=$1 AND ada_code=$2) OR member_id=$3 FOR UPDATE', [SOURCE, body.adaCode, id])).rows;
    if (existing.some(l => l.member_id !== id)) fail('ADA_ALREADY_LINKED');
    if (existing.some(l => l.ada_code !== body.adaCode)) fail('MEMBER_ALREADY_LINKED');
    if (existing.length) { await client.query('COMMIT'); return { ok: true, memberId: id, adaCode: body.adaCode, alreadyLinked: true }; }
    if (signed.expires < Date.now()) fail('OPTIONS_EXPIRED');
    const c = (await client.query(`SELECT c.ada_code,c.payload_hash FROM ada_history.customers c
      WHERE c.source_id=$1 AND c.ada_code=$2 AND ${matches('c', '$3')} FOR UPDATE`, [SOURCE, body.adaCode, phone(m.phone_number)])).rows[0];
    if (!/^0\d{9}$/.test(phone(m.phone_number)) || !c || signed.memberHash !== digest([m.full_name, m.phone_number]) || signed.candidateHash !== c.payload_hash) fail('PHONE_CHANGED');
    const conflict = await client.query(`SELECT r.doc_no FROM ada_history.receipts r JOIN public.loyalty_claims lc
      ON UPPER(BTRIM(lc.branch_code))=UPPER(BTRIM(r.branch_code)) AND UPPER(BTRIM(lc.receipt_no))=UPPER(BTRIM(r.doc_no))
      WHERE r.source_id=$1 AND r.customer_code=$2 AND lc.user_id::text<>$3 LIMIT 1`, [SOURCE, body.adaCode, id]);
    if (conflict.rows.length) fail('BILL_OWNER_CONFLICT');
    const reference = JSON.stringify({ via: 'StockDay admin website', actorId: body.actor.id, approvedAt: new Date().toISOString(), memberId: id, adaCode: body.adaCode });
    await client.query('INSERT INTO ada_history.member_links(member_id,source_id,ada_code,approval_reference) VALUES($1,$2,$3,$4)', [id, SOURCE, body.adaCode, reference]);
    await client.query('COMMIT');
    return { ok: true, memberId: id, adaCode: body.adaCode, alreadyLinked: false };
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') fail('ADA_ALREADY_LINKED');
    if (['55P03', '40P01', '40001'].includes(error.code)) fail('PHONE_CHANGED');
    throw error;
  } finally { client.release(); }
}

function requireLinkAdmin(req, res, next) {
  const expected = String(process.env.SC_OFFICIAL_ADA_LINK_ADMIN_TOKEN || ''), actual = String(req.headers['x-ada-link-admin-token'] || '');
  if (expected.length < 32) return res.status(503).json({ error: messages.LINK_UNAVAILABLE });
  const a = Buffer.from(actual), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).json({ error: 'Forbidden.' });
  return next();
}

module.exports = { pendingLinks, linkOptions, confirmLink, requireLinkAdmin };
