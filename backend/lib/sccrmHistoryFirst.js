'use strict';

// The public receipt/member records are committed by the caller together with
// this private outbox. This module never creates an Ada sale or awards points.
const { randomUUID } = require('node:crypto');
const authority = require('./adaPointAuthority');
const workflow = require('./adaPointWorkflow');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BRANCHES = ['001', '003', '004', '005'];
const MARKER = '9bde36f3-a235-4228-9e6f-190126a213f5';
const SCOPE = 'SCCRM-HISTORY-FIRST-V1';
let wake = () => {};

function enabled() {
  const value = process.env.SC_OFFICIAL_SCCRM_HISTORY_FIRST_ENABLED;
  if (value === undefined || value === '' || value === 'false') return false;
  if (value !== 'true') throw new Error('HISTORY_FIRST_CONFIGURATION_INVALID');
  return authority.enabled();
}
function failure(code, message, status = 409) { return Object.assign(new Error(message), { code, status }); }
function branch(device) {
  if (!BRANCHES.includes(device?.branch_code)) throw failure('STAFF_BRANCH_REQUIRED', 'กรุณากำหนดสาขาของเครื่องก่อน', 403);
  return device.branch_code;
}
async function available(db) {
  if (!enabled()) return false;
  const { rows } = await db.query(`SELECT marker::text,scope,schema_version,enabled FROM sccrm_receipt_sync.meta WHERE singleton=true`);
  if (rows.length !== 1 || rows[0].marker !== MARKER || rows[0].scope !== SCOPE || rows[0].schema_version !== 1) throw new Error('HISTORY_FIRST_SCHEMA_REFUSED');
  return rows[0].enabled === true;
}
async function enqueue(db, { memberId, branchCode, posCode = null, claimId = null }) {
  if (!enabled()) return null;
  if (!UUID.test(memberId || '') || !BRANCHES.includes(branchCode) || (posCode !== null && !/^\d{3}$/.test(posCode))) {
    throw failure('INVALID_SYNC_IDENTITY', 'ข้อมูลสมาชิกหรือสาขาไม่ถูกต้อง', 400);
  }
  if (!await available(db)) throw failure('HISTORY_FIRST_PAUSED', 'ขณะนี้ยังบันทึกคิวส่งข้อมูลไม่ได้ กรุณาลองใหม่', 503);
  const kind = claimId ? 'receipt' : 'member';
  const reference = claimId || memberId;
  const { rows } = await db.query(`INSERT INTO sccrm_receipt_sync.jobs
    (id,kind,reference_id,member_id,claim_id,origin_branch,origin_pos)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(kind,reference_id) DO NOTHING RETURNING *`,
  [randomUUID(), kind, reference, memberId, claimId, branchCode, posCode]);
  if (rows[0]) {
    await db.query(`INSERT INTO sccrm_receipt_sync.events(job_id,state,code) VALUES($1,'pending','SCCRM_STORED')`, [rows[0].id]);
    return rows[0].id;
  }
  const existing = (await db.query('SELECT id,member_id,claim_id,origin_branch FROM sccrm_receipt_sync.jobs WHERE kind=$1 AND reference_id=$2', [kind, reference])).rows[0];
  if (!existing || existing.member_id.toLowerCase() !== memberId.toLowerCase() || existing.claim_id !== claimId || existing.origin_branch !== branchCode) {
    throw failure('SYNC_IDENTITY_CONFLICT', 'รายการนี้ผูกกับข้อมูลอื่นแล้ว');
  }
  return existing.id;
}
async function enqueueRegistration(db, value) {
  if (!enabled() || !BRANCHES.includes(value.branchCode)) return null;
  return enqueue(db, value);
}

// An unavailable Ada view must not abort the surrounding SCCRM transaction.
// A known other owner still blocks the claim before any receipt is stored.
async function checkKnownOwner(db, { memberId, branchCode, receiptNo }) {
  await db.query('SAVEPOINT sccrm_history_owner');
  try {
    await workflow.nativeReceipt(db, branchCode, receiptNo, memberId, false);
    await db.query('RELEASE SAVEPOINT sccrm_history_owner');
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT sccrm_history_owner');
    await db.query('RELEASE SAVEPOINT sccrm_history_owner');
    if (error.code === 'BILL_OWNER_CONFLICT') throw error;
  }
}
function pendingPoints() {
  return { awardedPoints: 0, awardedPointsExact: null, balance: null, balanceExact: null,
    pointsAvailable: false, pointsSource: 'ada', pointsStatus: 'pending_ada', pointsCredited: false,
    revision: 'ada-native-recorded', appliedPromotions: [] };
}

async function observeMember(db, job) {
  const row = (await db.query(`SELECT m.member_code, l.ada_code AS linked_code,
      a.assignment_id,a.ada_code AS assigned_code,a.deliver_to_branches,
      o.state AS outbound_state,o.last_code AS outbound_code
    FROM public.member_profiles m
    LEFT JOIN ada_history.member_links l ON l.member_id=m.user_id AND l.source_id='hq000/AdaAcc'
      AND l.ada_code=CASE WHEN left(m.member_code,4)='ADA-' THEN substring(m.member_code from 5) ELSE m.member_code END
    LEFT JOIN sccrm_member_codes.assignments a ON a.member_id=m.user_id
    LEFT JOIN ada_history.outbound_state o ON o.member_id=m.user_id WHERE m.user_id=$1`, [job.member_id])).rows[0];
  if (!row) return { state: 'review', code: 'MEMBER_NOT_FOUND', evidence: {} };
  const evidence = { hqReady: false, adaCode: row.member_code, branches: [] };
  if (!row.linked_code) {
    return { state: row.outbound_state === 'review' ? 'review' : 'retry',
      code: row.outbound_state === 'review' ? 'MEMBER_REQUIRES_REVIEW' : 'WAITING_FOR_HQ', evidence };
  }
  if (row.assigned_code && row.assigned_code !== row.linked_code) return { state: 'review', code: 'MEMBER_MAPPING_CONFLICT', evidence };
  evidence.hqReady = true;
  evidence.adaCode = row.linked_code;
  // Existing approved customers are not mass-propagated to other branches.
  if (!row.assignment_id || !row.deliver_to_branches) {
    evidence.legacyLink = true;
    return { state: 'succeeded', code: 'EXISTING_MEMBER_LINK_VERIFIED', evidence };
  }
  const targets = (await db.query(`SELECT t.branch_code,t.enabled,j.state,j.last_code,
      (mp.member_id=$2 AND mp.ada_code=$3 AND mp.assignment_id=$1) AS mapped
    FROM sccrm_member_codes.targets t
    LEFT JOIN sccrm_member_codes.jobs j ON j.target_id=t.target_id AND j.assignment_id=$1
    LEFT JOIN sccrm_member_codes.mappings mp ON mp.target_id=t.target_id AND mp.assignment_id=$1
    ORDER BY t.branch_code`, [row.assignment_id, job.member_id, row.linked_code])).rows;
  evidence.branches = targets.map(t => ({ branchCode: t.branch_code,
    ready: t.state === 'succeeded' && t.mapped === true, state: t.state || 'pending', code: t.last_code || null }));
  if (targets.some(t => t.state === 'review')) return { state: 'review', code: 'BRANCH_REQUIRES_REVIEW', evidence };
  const complete = BRANCHES.every(code => evidence.branches.filter(b => b.branchCode === code && b.ready).length === 1);
  return { state: complete ? 'succeeded' : 'retry', code: complete ? 'MEMBER_ALL_BRANCHES_VERIFIED' : 'WAITING_FOR_BRANCHES', evidence };
}
async function observe(db, job) {
  const member = await observeMember(db, job);
  if (job.kind === 'member') return member;
  // A different offline branch must never hold up this branch's receipt.
  const originReady = member.evidence.hqReady && (member.evidence.legacyLink ||
    member.evidence.branches.some(b => b.branchCode === job.origin_branch && b.ready));
  if (!originReady) return member;
  const claim = (await db.query(`SELECT receipt_no,branch_code,user_id::text,receipt_snapshot,sold_at FROM public.loyalty_claims WHERE id=$1`, [job.claim_id])).rows[0];
  if (!claim || claim.user_id.toLowerCase() !== job.member_id.toLowerCase() || claim.branch_code !== job.origin_branch) {
    return { state: 'review', code: 'RECEIPT_IDENTITY_CONFLICT', evidence: member.evidence };
  }
  try {
    const native = await workflow.nativeReceipt(db, claim.branch_code, claim.receipt_no, job.member_id, false);
    const delivered = await require('./sccrmReceiptDelivery').schedule(db, job, claim, member);
    if (delivered.state === 'succeeded') {
      try {
        const points = await authority.readReceiptPoints(db, { branchCode: claim.branch_code, receiptNo: claim.receipt_no, memberId: job.member_id });
        delivered.evidence.pointsStatus = points.pointsStatus;
        delivered.evidence.awardedPointsExact = points.awardedPointsExact;
      } catch { delivered.evidence.pointsStatus = 'pending_ada'; }
    }
    return delivered;
  } catch (error) {
    return { state: ['BILL_OWNER_CONFLICT', 'ADA_POINTS_EVENT_REVIEW', 'ADA_POINTS_EVENT_INVALID'].includes(error.code) ? 'review' : 'retry',
      code: error.code === 'BILL_OWNER_CONFLICT' ? 'BILL_OWNER_CONFLICT' : 'WAITING_FOR_ADA_POINTS', evidence: member.evidence };
  }
}
async function lease(db) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(`SELECT * FROM sccrm_receipt_sync.jobs
      WHERE (state IN('pending','retry') AND next_attempt_at<=now()) OR (state='running' AND lease_until<now())
      ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
    if (!row) { await client.query('COMMIT'); return null; }
    const token = randomUUID();
    const job = (await client.query(`UPDATE sccrm_receipt_sync.jobs SET state='running',lease_token=$2,
      lease_until=now()+interval '45 seconds',attempt_count=attempt_count+1,updated_at=now() WHERE id=$1 RETURNING *`, [row.id, token])).rows[0];
    await client.query(`INSERT INTO sccrm_receipt_sync.events(job_id,state,code) VALUES($1,'running',$2)`, [row.id, row.state === 'running' ? 'EXPIRED_LEASE_RECOVERED' : 'VERIFYING_ADA']);
    await client.query('COMMIT'); return job;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function finish(db, job, outcome) {
  const delay = outcome.state === 'retry' ? Math.min(300, 5 * Math.pow(2, Math.min(6, Math.floor((job.attempt_count - 1) / 5)))) : 0;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const changed = await client.query(`UPDATE sccrm_receipt_sync.jobs SET state=$3,last_code=$4,evidence=$5::jsonb,
      next_attempt_at=now()+($6::int*interval '1 second'),lease_token=NULL,lease_until=NULL,updated_at=now(),
      completed_at=CASE WHEN $3='succeeded' THEN now() ELSE NULL END
      WHERE id=$1 AND state='running' AND lease_token=$2 AND lease_until>now() RETURNING id`,
    [job.id, job.lease_token, outcome.state, outcome.code, JSON.stringify(outcome.evidence || {}), delay]);
    if (changed.rows.length) await client.query(`INSERT INTO sccrm_receipt_sync.events(job_id,state,code) VALUES($1,$2,$3)`, [job.id, outcome.state, outcome.code]);
    await client.query('COMMIT'); return changed.rows.length === 1;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function runOnce(db, { inspect = observe, limit = 10 } = {}) {
  if (!await available(db)) return { processed: 0 };
  let processed = 0;
  for (; processed < limit; processed++) {
    const job = await lease(db); if (!job) break;
    let outcome;
    try { outcome = await inspect(db, job); }
    catch { outcome = { state: 'retry', code: 'SYNC_SOURCE_UNAVAILABLE', evidence: job.evidence || {} }; }
    await finish(db, job, outcome);
  }
  return { processed };
}

const LABELS = {
  SCCRM_STORED: 'บันทึกใน SCCRM แล้ว รอส่งข้อมูล', VERIFYING_ADA: 'กำลังตรวจข้อมูลใน Ada',
  SENDING_ADA_RECEIPT: 'กำลังส่งชื่อสมาชิกลงบิล Ada เดิม', NATIVE_LEASE_RECOVERED: 'นำการส่งบิลที่ขาดการตอบรับกลับมาตรวจใหม่',
  WAITING_FOR_ADA_RECEIPT_DELIVERY: 'ประวัติอยู่ใน SCCRM แล้ว รอเติมสมาชิกลงบิล Ada',
  ADA_RECEIPT_REQUIRES_REVIEW: 'ประวัติอยู่ใน SCCRM แล้ว การส่งบิล Ada ต้องตรวจสอบ',
  RECEIPT_SNAPSHOT_INCOMPLETE: 'ประวัติอยู่ใน SCCRM แล้ว ข้อมูลบิลยังไม่ครบสำหรับส่ง Ada',
  RECEIPT_OTHER_MEMBER: 'บิล Ada เป็นชื่อคนอื่น ระบบพักไว้และไม่ได้เปลี่ยนชื่อ',
  RECEIPT_ALREADY_OWNED: 'บิลนี้มีรายการผูกสมาชิกอยู่แล้ว ต้องให้ผู้ดูแลตรวจสอบ',
  RECEIPT_MEMBER_REQUIRES_REVIEW: 'ข้อมูลสมาชิกใน Ada ยังไม่ตรงกัน ต้องตรวจสอบก่อน',
  RECEIPT_HEADER_CHANGED: 'ยอด วันเวลา หรือสถานะบิล Ada ไม่ตรง ต้องตรวจสอบ',
  RECEIPT_ITEMS_CHANGED: 'รายการสินค้าในบิล Ada ไม่ตรง ต้องตรวจสอบ',
  RECEIPT_NOT_ARRIVED: 'ยังไม่พบบิลในฐาน Ada ปลายทาง ระบบจะลองใหม่',
  RECEIPT_SOURCE_UNAVAILABLE: 'ยังติดต่อฐาน Ada ไม่ได้ ระบบจะลองใหม่',
  RECEIPT_SOURCE_RETRY: 'ฐาน Ada ยังไม่พร้อม ระบบจะลองใหม่',
  RECEIPT_BUSY: 'Ada กำลังใช้งานบิลนี้ ระบบจะลองใหม่',
  WAITING_FOR_HQ: 'บันทึกใน SCCRM แล้ว รอสมาชิกเข้า Ada HQ', WAITING_FOR_BRANCHES: 'Ada HQ รับแล้ว รอส่งถึงสาขา',
  MEMBER_ALL_BRANCHES_VERIFIED: 'ตรวจพบสมาชิกใน Ada ครบทุกสาขาแล้ว', EXISTING_MEMBER_LINK_VERIFIED: 'ผูกกับสมาชิก Ada เดิมแล้ว',
  WAITING_FOR_ADA_RECEIPT: 'ประวัติอยู่ใน SCCRM แล้ว ยังไม่พบการผูกบิลนี้กับสมาชิกใน Ada',
  WAITING_FOR_ADA_POINTS: 'ประวัติอยู่ใน SCCRM แล้ว รอข้อมูลแต้มจาก Ada', ADA_RECEIPT_VERIFIED: 'ตรวจพบบิลของสมาชิกใน Ada แล้ว',
  BILL_OWNER_CONFLICT: 'บิลใน Ada เป็นชื่อสมาชิกอื่น ต้องให้ผู้ดูแลตรวจสอบ',
  MEMBER_REQUIRES_REVIEW: 'ข้อมูลสมาชิกต้องตรวจสอบก่อนส่งเข้า Ada', BRANCH_REQUIRES_REVIEW: 'ข้อมูลสมาชิกที่สาขาต้องตรวจสอบ',
  MEMBER_MAPPING_CONFLICT: 'รหัสสมาชิกไม่ตรงกัน ต้องให้ผู้ดูแลตรวจสอบ', RECEIPT_IDENTITY_CONFLICT: 'ข้อมูลบิลไม่ตรงกัน ต้องให้ผู้ดูแลตรวจสอบ',
  MEMBER_NOT_FOUND: 'ไม่พบข้อมูลสมาชิก ต้องให้ผู้ดูแลตรวจสอบ', SYNC_SOURCE_UNAVAILABLE: 'ยังติดต่อระบบซิงก์ไม่ได้ ระบบจะลองใหม่',
  MANUAL_RETRY: 'รับคำขอลองใหม่แล้ว', EXPIRED_LEASE_RECOVERED: 'นำงานที่ขาดการตอบรับกลับมาตรวจใหม่',
};
function label(code) { return LABELS[code] || 'รอตรวจข้อมูลกับ Ada'; }
function publicJob(row) {
  return { id: row.id, kind: row.kind, memberId: row.member_id, memberName: row.full_name || '', memberCode: row.member_code || '',
    receiptNo: row.receipt_no || null, branchCode: row.origin_branch, state: row.state, code: row.last_code || 'SCCRM_STORED',
    label: label(row.last_code || 'SCCRM_STORED'), attempts: row.attempt_count, createdAt: row.created_at, updatedAt: row.updated_at,
    nextAttemptAt: row.state === 'retry' || row.state === 'pending' ? row.next_attempt_at : null,
    evidence: row.evidence || {}, sccrmStored: true };
}
async function list(db, staff, query = {}) {
  const code = branch(staff);
  if (Object.keys(query).some(k => !['memberId'].includes(k)) || (query.memberId && !UUID.test(query.memberId))) throw failure('INVALID_SYNC_QUERY', 'ข้อมูลค้นหาไม่ถูกต้อง', 400);
  const { rows } = await db.query(`SELECT j.*,u.full_name,m.member_code,c.receipt_no FROM sccrm_receipt_sync.jobs j
    JOIN public.users u ON u.id=j.member_id JOIN public.member_profiles m ON m.user_id=u.id
    LEFT JOIN public.loyalty_claims c ON c.id=j.claim_id
    WHERE j.origin_branch=$1 AND ($2::uuid IS NULL OR j.member_id=$2::uuid) ORDER BY j.created_at DESC,j.id DESC LIMIT 100`, [code, query.memberId || null]);
  return { ok: true, jobs: rows.map(publicJob) };
}
async function detail(db, staff, id) {
  const code = branch(staff); if (!UUID.test(id)) throw failure('INVALID_SYNC_JOB', 'รายการไม่ถูกต้อง', 400);
  const row = (await db.query(`SELECT j.*,u.full_name,m.member_code,c.receipt_no FROM sccrm_receipt_sync.jobs j
    JOIN public.users u ON u.id=j.member_id JOIN public.member_profiles m ON m.user_id=u.id
    LEFT JOIN public.loyalty_claims c ON c.id=j.claim_id WHERE j.id=$1 AND j.origin_branch=$2`, [id, code])).rows[0];
  if (!row) throw failure('SYNC_JOB_NOT_FOUND', 'ไม่พบรายการของสาขานี้', 404);
  const events = (await db.query(`SELECT state,code,occurred_at,target_branch FROM sccrm_receipt_sync.events WHERE job_id=$1 ORDER BY id DESC LIMIT 100`, [id])).rows;
  return { ok: true, job: publicJob(row), events: events.map(e => ({ state: e.state, code: e.code, at: e.occurred_at, label: (e.target_branch ? 'Ada '+e.target_branch+': ' : '') + label(e.code) })) };
}
async function retry(db, staff, id) {
  const code = branch(staff); if (!UUID.test(id)) throw failure('INVALID_SYNC_JOB', 'รายการไม่ถูกต้อง', 400);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT * FROM sccrm_receipt_sync.jobs WHERE id=$1 AND origin_branch=$2 FOR UPDATE', [id, code])).rows[0];
    if (!row) throw failure('SYNC_JOB_NOT_FOUND', 'ไม่พบรายการของสาขานี้', 404);
    if (row.state === 'running' || row.state === 'succeeded') { await client.query('COMMIT'); return { ok: true, alreadyHandled: true }; }
    if (row.manual_retry_at && Date.now() - new Date(row.manual_retry_at).getTime() < 10000) throw failure('SYNC_RETRY_TOO_SOON', 'รับคำขอแล้ว กรุณารอสักครู่');
    await client.query(`UPDATE sccrm_receipt_sync.jobs SET state='pending',next_attempt_at=now(),updated_at=now(),
      manual_retry_at=now(),last_code='MANUAL_RETRY',lease_token=NULL,lease_until=NULL WHERE id=$1`, [id]);
    await client.query(`INSERT INTO sccrm_receipt_sync.events(job_id,state,code) VALUES($1,'pending','MANUAL_RETRY')`, [id]);
    await require('./sccrmReceiptDelivery').retry(client,id);
    await client.query('COMMIT'); wake(); return { ok: true };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
function notify() { wake(); }
function start(db) {
  if (!enabled()) return () => {};
  let busy = false, stopped = false;
  const tick = async () => {
    if (busy || stopped) return; busy = true;
    try { await runOnce(db); } catch { console.error('SCCRM receipt sync: SYNC_CYCLE_RETRY'); }
    finally { busy = false; }
  };
  wake = () => { if (!stopped) setImmediate(tick); };
  const timer = setInterval(tick, 5000); timer.unref(); wake();
  return () => { stopped = true; clearInterval(timer); wake = () => {}; };
}
module.exports = { enabled, available, enqueue, enqueueRegistration, checkKnownOwner, pendingPoints, observeMember, observe,
  lease, finish, runOnce, list, detail, retry, start, notify, label, MARKER, SCOPE };
