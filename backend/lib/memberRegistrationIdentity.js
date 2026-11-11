'use strict';

const crypto = require('node:crypto');
const { normalizeThaiPhone } = require('./publicMemberRegistration');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SOURCE = 'hq000/AdaAcc';

function fail(code, message, status = 409) {
  throw Object.assign(new Error(message), { code, status });
}
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function sign(value) {
  const secret = process.env.SCCRM_REFRESH_TOKEN_SECRET;
  if (!secret) fail('REGISTRATION_REVIEW_UNAVAILABLE', 'ขณะนี้ยังตรวจสมาชิกเดิมไม่ได้ กรุณาลองอีกครั้ง', 503);
  return crypto.createHmac('sha256', secret).update('member-registration:' + value).digest('base64url');
}
function profile(body) {
  const phone = normalizeThaiPhone(body?.phone);
  const name = String(body?.name ?? body?.fullName ?? '').trim();
  if (!phone || !name || name.length > 200) fail('INVALID_REGISTRATION', 'กรุณากรอกชื่อและมือถือไทย 10 หลักให้ถูกต้อง', 400);
  return { name, phone, email: String(body?.email || '').trim().toLowerCase(),
    sex: body?.sex || null, dob: body?.dob || null, remark: body?.remark || null };
}
function exactPhone(raw, phone) {
  return String(raw || '').split(/[,;|/&\n]/).some(part => {
    const value = part.trim();
    return normalizeThaiPhone(/^66/.test(value) ? '+' + value : value) === phone;
  });
}

async function candidates(db, phone, name) {
  const memberRows = (await db.query(`SELECT u.id,u.full_name,u.phone_number,m.contact_phone,m.member_code,m.is_active,
      ARRAY(SELECT c.phone FROM ada_history.member_links l JOIN ada_history.customers c USING(source_id,ada_code)
        WHERE l.member_id=u.id ORDER BY c.ada_code) linked_phones,
      EXISTS(SELECT 1 FROM ada_history.member_links l WHERE l.member_id=u.id) AS linked
    FROM public.users u JOIN public.member_profiles m ON m.user_id=u.id
    WHERE regexp_replace(COALESCE(u.phone_number,''),'[^0-9]','','g') IN($1,'66'||substring($1 FROM 2),'0066'||substring($1 FROM 2)) OR m.contact_phone=$1 OR EXISTS(
      SELECT 1 FROM ada_history.member_links l JOIN ada_history.customers c USING(source_id,ada_code)
      WHERE l.member_id=u.id AND (regexp_replace(c.phone,'[ ()-]','','g') LIKE '%'||$1||'%'
        OR regexp_replace(c.phone,'[ ()-]','','g') LIKE '%66'||substring($1 FROM 2)||'%')) ORDER BY u.id LIMIT 101`, [phone])).rows;
  const members = memberRows.filter(row => [row.phone_number, row.contact_phone, ...row.linked_phones].some(raw => exactPhone(raw, phone)));
  const ada = (await db.query(`SELECT c.directory_id,c.ada_code,c.name,c.phone,c.payload_hash,c.active
    FROM ada_history.customers c WHERE c.source_id=$1 AND c.ada_code<>'0'
      AND (regexp_replace(c.phone,'[ ()-]','','g') LIKE '%'||$2||'%'
        OR regexp_replace(c.phone,'[ ()-]','','g') LIKE '%66'||substring($2 FROM 2)||'%')
      AND NOT EXISTS(SELECT 1 FROM ada_history.member_links l WHERE l.source_id=c.source_id AND l.ada_code=c.ada_code)
    ORDER BY c.ada_code LIMIT 101`, [SOURCE, phone])).rows.filter(row => exactPhone(row.phone, phone));
  if (memberRows.length > 100 || ada.length > 100) fail('REGISTRATION_REVIEW_TOO_LARGE', 'พบหลายชื่อ กรุณาให้ผู้ดูแลช่วยตรวจสอบ');
  const pending = members.filter(row => row.is_active && !row.linked && row.full_name === name && /^SCM-/.test(row.member_code));
  const pair = pending.length === 1 && ada.length === 1 && ada[0].active === '1' ? pending[0] : null;
  const rows = members.filter(row => row !== pair).map(row => ({
    id: 'member:' + row.id, memberId: row.id, name: row.full_name,
    phone, memberCode: row.member_code, adaCode: null,
    canUseExisting: row.is_active,
    fingerprint: hash([row.id, row.full_name, row.phone_number, row.contact_phone, row.member_code, row.is_active, row.linked, row.linked_phones]),
  }));
  for (const row of ada) rows.push({
    id: 'ada:' + row.ada_code, memberId: pair?.id || row.directory_id,
    pendingMemberId: pair?.id || null, name: row.name, phone: row.phone,
    memberCode: row.ada_code, adaCode: row.ada_code,
    canUseExisting: row.active === '1',
    fingerprint: hash([row.directory_id, row.payload_hash, pair?.id || null, pair?.member_code || null]),
  });
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}
function publicCandidates(rows) {
  return rows.map(row => ({ id: row.id, name: row.name, phone: row.phone, memberCode: row.memberCode, canUseExisting: row.canUseExisting }));
}
async function options(db, body, staff) {
  const value = profile(body);
  if (!UUID.test(body.requestId || '')) fail('INVALID_REGISTRATION', 'กรุณาเปิดหน้าสมัครอีกครั้ง', 400);
  const saved = (await db.query('SELECT member_id,staff_device_id,draft_hash,action FROM sccrm_registration.confirmations WHERE request_id=$1', [body.requestId])).rows[0];
  if (saved) {
    if (saved.staff_device_id !== staff.id || saved.draft_hash !== hash(value)) fail('REGISTRATION_ALREADY_SAVED', 'ข้อมูลนี้บันทึกแล้ว กรุณาค้นชื่อสมาชิกเพื่อแก้ไข');
    return { ok: true, requestId: body.requestId, completedMemberId: saved.member_id, completedAction: saved.action, candidates: [] };
  }
  const rows = await candidates(db, value.phone, value.name);
  const payload = Buffer.from(JSON.stringify({ version: 1, actor: staff.id, requestId: body.requestId,
    profileHash: hash(value), candidatesHash: hash(rows), expires: Date.now() + 10 * 60 * 1000 })).toString('base64url');
  return { ok: true, requestId: body.requestId, reviewToken: payload + '.' + sign(payload), candidates: publicCandidates(rows) };
}
function verify(decision, value, staff) {
  if (!decision || typeof decision !== 'object' || !UUID.test(decision.requestId || '')
      || !['existing', 'new'].includes(decision.action) || typeof decision.reviewToken !== 'string'
      || decision.reviewToken.length > 4096) fail('INVALID_REGISTRATION_REVIEW', 'กรุณาตรวจรายชื่ออีกครั้ง', 400);
  const parts = decision.reviewToken.split('.');
  if (parts.length !== 2) fail('INVALID_REGISTRATION_REVIEW', 'กรุณาตรวจรายชื่ออีกครั้ง', 400);
  const expected = Buffer.from(sign(parts[0])), actual = Buffer.from(parts[1]);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) fail('INVALID_REGISTRATION_REVIEW', 'กรุณาตรวจรายชื่ออีกครั้ง', 400);
  let signed;
  try { signed = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); }
  catch { fail('INVALID_REGISTRATION_REVIEW', 'กรุณาตรวจรายชื่ออีกครั้ง', 400); }
  if (signed.version !== 1 || signed.actor !== staff.id || signed.requestId !== decision.requestId
      || signed.profileHash !== hash(value)) fail('REGISTRATION_CHANGED', 'ข้อมูลเปลี่ยนแล้ว กรุณาตรวจรายชื่ออีกครั้ง');
  return signed;
}

async function chooseExisting(db, chosen, value, staff, requestId) {
  if (!chosen.adaCode) {
    const active = (await db.query(`SELECT u.id FROM public.users u JOIN public.member_profiles m ON m.user_id=u.id
      WHERE u.id=$1 AND m.is_active=true FOR UPDATE OF u,m`, [chosen.memberId])).rows[0];
    if (!active) fail('REGISTRATION_CHANGED', 'ชื่อนี้ปิดใช้งานแล้ว กรุณาตรวจรายชื่ออีกครั้ง');
    const locked = (await candidates(db, value.phone, value.name)).find(row => row.id === chosen.id);
    if (!locked || locked.fingerprint !== chosen.fingerprint) fail('REGISTRATION_CHANGED', 'ข้อมูลสมาชิกเปลี่ยนแล้ว กรุณาตรวจรายชื่ออีกครั้ง');
    return chosen.memberId;
  }
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['ada-link-code:' + SOURCE + ':' + chosen.adaCode]);
  const row = (await db.query(`SELECT directory_id,payload_hash FROM ada_history.customers
    WHERE source_id=$1 AND ada_code=$2 AND active='1' FOR UPDATE`, [SOURCE, chosen.adaCode])).rows[0];
  if (!row) fail('REGISTRATION_CHANGED', 'ข้อมูลสมาชิกเปลี่ยนแล้ว กรุณาตรวจรายชื่ออีกครั้ง');
  const locked = (await candidates(db, value.phone, value.name)).find(item => item.id === chosen.id);
  if (!locked || locked.fingerprint !== chosen.fingerprint) fail('REGISTRATION_CHANGED', 'ข้อมูลสมาชิกเปลี่ยนแล้ว กรุณาตรวจรายชื่ออีกครั้ง');
  const links = (await db.query('SELECT member_id FROM ada_history.member_links WHERE source_id=$1 AND ada_code=$2 FOR UPDATE', [SOURCE, chosen.adaCode])).rows;
  if (links.length) fail('REGISTRATION_CHANGED', 'มีการเลือกสมาชิกนี้แล้ว กรุณาตรวจรายชื่ออีกครั้ง');
  const id = chosen.memberId;
  if (!chosen.pendingMemberId) {
    await db.query(`INSERT INTO public.users(id,full_name,phone_number,email,sex,dob,is_verified)
      VALUES($1,$2,NULL,NULL,$3,$4,false)`, [id, value.name, value.sex, value.dob]);
    await db.query(`INSERT INTO public.member_profiles(user_id,member_code,contact_phone)
      VALUES($1,$2,$3)`, [id, chosen.adaCode, value.phone]);
  } else {
    const current = (await db.query('SELECT member_code FROM public.member_profiles WHERE user_id=$1 AND is_active=true FOR UPDATE', [id])).rows[0];
    if (!current || !/^SCM-/.test(current.member_code)) fail('REGISTRATION_CHANGED', 'รหัสสมาชิกเปลี่ยนแล้ว กรุณาตรวจอีกครั้ง');
    await db.query('UPDATE public.member_profiles SET member_code=$2,updated_at=now() WHERE user_id=$1', [id, chosen.adaCode]);
    chosen.previousCode = current.member_code;
  }
  const conflict = await db.query(`SELECT 1 FROM ada_history.receipts r JOIN public.loyalty_claims lc
    ON upper(btrim(lc.branch_code))=upper(btrim(r.branch_code)) AND upper(btrim(lc.receipt_no))=upper(btrim(r.doc_no))
    WHERE r.source_id=$1 AND r.customer_code=$2 AND lc.user_id<>$3 LIMIT 1`, [SOURCE, chosen.adaCode, id]);
  if (conflict.rows.length) fail('BILL_OWNER_CONFLICT', 'ประวัติของรหัสนี้มีข้อมูลที่ต้องตรวจ กรุณาให้ผู้ดูแลช่วย');
  await db.query('INSERT INTO ada_history.member_links(member_id,source_id,ada_code,approval_reference) VALUES($1,$2,$3,$4)',
    [id, SOURCE, chosen.adaCode, JSON.stringify({ via: 'cashier confirmation', requestId, staffDeviceId: staff.id })]);
  await db.query(`UPDATE ada_history.outbound_state SET state='created',ada_code=$2,last_code=NULL,updated_at=now()
    WHERE member_id=$1`, [id, chosen.adaCode]);
  return id;
}

async function confirm(pool, body, staff, create) {
  const value = profile(body), decision = body.registrationDecision;
  const signed = verify(decision, value, staff);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='15s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['member-registration:' + value.phone]);
    const old = (await client.query('SELECT * FROM sccrm_registration.confirmations WHERE request_id=$1', [decision.requestId])).rows[0];
    const requestHash = hash([value, decision.action, decision.candidateId || null]);
    if (old) {
      if (old.staff_device_id !== staff.id || old.request_hash !== requestHash) fail('REGISTRATION_CHANGED', 'คำขอนี้มีข้อมูลต่างจากเดิม กรุณาเปิดหน้าสมัครใหม่');
      await client.query('COMMIT');
      return { memberId: old.member_id, outcome: old.action, replayed: true };
    }
    const rows = await candidates(client, value.phone, value.name);
    if (!Number.isFinite(signed.expires) || signed.expires < Date.now() || signed.candidatesHash !== hash(rows)) {
      fail('REGISTRATION_CHANGED', 'รายชื่อเปลี่ยนหรือหมดเวลาแล้ว กรุณาตรวจและเลือกอีกครั้ง');
    }
    let memberId, previousCode = null;
    if (decision.action === 'existing') {
      const chosen = rows.find(row => row.id === decision.candidateId);
      if (!chosen || !chosen.canUseExisting) fail('REGISTRATION_CHANGED', 'กรุณาเลือกชื่อที่เปิดใช้งานจากรายชื่อที่แสดง');
      memberId = await chooseExisting(client, chosen, value, staff, decision.requestId);
      previousCode = chosen.previousCode || null;
    } else {
      const occupied = (await client.query('SELECT id FROM public.users WHERE phone_number=$1', [value.phone])).rows.length > 0;
      memberId = await create(client, { primaryPhone: occupied ? null : value.phone, contactPhone: occupied ? value.phone : null });
    }
    // The digest matches the worker's canonical {email,name,phone} fingerprint.
    const nativeHash = hash({ email: value.email || null, name: value.name, phone: value.phone });
    await client.query(`INSERT INTO sccrm_registration.confirmations
      (request_id,staff_device_id,member_id,action,contact_phone,request_hash,draft_hash,profile_hash,allow_shared_contact,previous_code)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [decision.requestId, staff.id, memberId, decision.action,
      value.phone, requestHash, hash(value), nativeHash, decision.action === 'new' && rows.length > 0, previousCode]);
    await require('./sccrmHistoryFirst').enqueueRegistration(client, { memberId, branchCode: staff.branch_code });
    await client.query('COMMIT');
    return { memberId, outcome: decision.action, replayed: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
module.exports = { options, confirm, profile, candidates };
