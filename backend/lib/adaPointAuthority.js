'use strict';

/*
 * Read contract for the private worker-owned cache (this module never creates it):
 *   ada_points.balance_cache(
 *     ada_code text PRIMARY KEY, balance numeric, observed_at timestamptz, state text
 *   )
 * Only state='ready' with a fresh observation is authoritative. The worker must
 * supply the reconciled Ada balance, not just TCNMCst.FCCstRetPoint. An unavailable
 * source is never substituted with zero, a stale value, or the SCCRM point ledger.
 *
 * A materialized SCCRM member resolves ONLY through its current AR member_code
 * and the matching approved HQ link. Other linked aliases are not summed. For an
 * unmaterialized Ada contact the caller can use readCodeBalance with its raw code.
 * Native receipt contract: ada_points.native_events(event_key char(64) PRIMARY
 * KEY,origin_branch text,ada_code text,doc_no text,supplier_code text,card_type
 * text,points bigint,contribution bigint,active boolean,state text,business_hash
 * char(64),sources text[],business_payload jsonb). The worker deduplicates and
 * reconciles source copies before state='ready'. These readers never write it.
 * These readers return balances, not an authorization decision or profile data.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AR_CODE = /^AR[0-9]{3}-[0-9]{6}$/;
const NATIVE_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/;
const DEFAULT_MAX_AGE_SECONDS = 120;
const MAX_CLOCK_LEAD_MS = 5000;

function configurationError() {
  return Object.assign(new Error('Ada point authority configuration is invalid.'), {
    code: 'ADA_POINTS_CONFIGURATION_INVALID', status: 503,
  });
}

function enabled() {
  const mode = process.env.SC_OFFICIAL_ADA_POINTS_MODE;
  if (mode === undefined || mode === '' || mode === 'off') return false;
  if (mode !== 'ada-primary') throw configurationError();
  maxAgeSeconds();
  return true;
}

function maxAgeSeconds() {
  const raw = process.env.SC_OFFICIAL_ADA_POINTS_MAX_AGE_SECONDS;
  if (raw === undefined || raw === '') return DEFAULT_MAX_AGE_SECONDS;
  if (!/^[0-9]+$/.test(raw)) throw configurationError();
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 5 || seconds > 3600) throw configurationError();
  return seconds;
}

function invalid(code) {
  return Object.assign(new Error('Invalid Ada point balance lookup.'), { code, status: 400 });
}

function memberIds(values) {
  if (!Array.isArray(values) || values.length > 100) throw invalid('INVALID_MEMBER_IDS');
  const unique = new Set();
  for (const id of values) {
    if (typeof id !== 'string' || !UUID.test(id)) throw invalid('INVALID_MEMBER_IDS');
    unique.add(id.toLowerCase());
  }
  return [...unique];
}

function unavailable(reason, observedAt = null) {
  return { available: false, reason, balanceExact: null, balance: null, observedAt };
}

function normalizedDecimal(text) {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?$/.exec(text);
  if (!match) return null;
  const integer = match[2].replace(/^0+(?=[0-9])/, '');
  const fraction = (match[3] || '').replace(/0+$/, '');
  const negative = match[1] && (integer !== '0' || fraction) ? '-' : '';
  return negative + integer + (fraction ? '.' + fraction : '');
}

// Number.toString may use exponent notation even when numeric::text does not.
function expandedNumber(value) {
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  const negative = mantissa.startsWith('-');
  const [integer, fraction = ''] = mantissa.replace(/^-/, '').split('.');
  const digits = integer + fraction;
  const index = integer.length + Number(exponent);
  const decimal = index <= 0 ? '0.' + '0'.repeat(-index) + digits
    : index >= digits.length ? digits + '0'.repeat(index - digits.length)
      : digits.slice(0, index) + '.' + digits.slice(index);
  return normalizedDecimal((negative ? '-' : '') + decimal);
}

function safeNumber(exact) {
  const value = Number(exact);
  if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) return null;
  return expandedNumber(value) === normalizedDecimal(exact) ? (Object.is(value, -0) ? 0 : value) : null;
}

function balanceResult(row, now, maximumAgeSeconds) {
  if (!row) return unavailable('unknown');
  if (row.state !== 'ready') return unavailable('source_unavailable');
  const observed = row.observed_at instanceof Date ? row.observed_at : new Date(row.observed_at);
  if (row.observed_at == null || !Number.isFinite(observed.getTime())) return unavailable('source_unavailable');
  const age = now - observed.getTime();
  if (age < -MAX_CLOCK_LEAD_MS) return unavailable('source_unavailable');
  const observedAt = observed.toISOString();
  if (age > maximumAgeSeconds * 1000) return unavailable('stale', observedAt);
  // numeric::text below preserves decimal precision, including beyond JS Number.
  const exact = row.balance_exact;
  if (typeof exact !== 'string' || exact.length > 1024 || normalizedDecimal(exact) == null) {
    return unavailable('source_unavailable', observedAt);
  }
  return { available: true, balanceExact: exact, balance: safeNumber(exact), observedAt };
}

async function readCodeBalance(db, code) {
  if (typeof code !== 'string' || !NATIVE_CODE.test(code)) throw invalid('INVALID_ADA_CODE');
  if (!enabled()) return unavailable('disabled');
  const maximumAgeSeconds = maxAgeSeconds();
  let rows;
  try {
    ({ rows } = await db.query(`SELECT ada_code, balance::text AS balance_exact, observed_at, state
      FROM ada_points.balance_cache WHERE ada_code = $1`, [code]));
  } catch {
    return unavailable('source_unavailable');
  }
  if (!Array.isArray(rows) || rows.length > 1) return unavailable('source_unavailable');
  if (!rows.length) return unavailable('unknown');
  if (rows[0].ada_code !== code) return unavailable('source_unavailable');
  return balanceResult(rows[0], Date.now(), maximumAgeSeconds);
}

async function readMemberBalances(db, values) {
  const ids = memberIds(values);
  const isEnabled = enabled();
  const results = new Map(ids.map(id => [id, unavailable(isEnabled ? 'unknown' : 'disabled')]));
  if (!isEnabled || !ids.length) return results;
  const maximumAgeSeconds = maxAgeSeconds();
  let rows;
  try {
    ({ rows } = await db.query(`WITH requested AS (SELECT unnest($1::uuid[]) AS member_id)
      SELECT r.member_id::text AS member_id, m.member_code AS canonical_code,
        l.ada_code AS mapped_code, b.ada_code AS cache_code,
        b.balance::text AS balance_exact, b.observed_at, b.state
      FROM requested r
      LEFT JOIN public.member_profiles m ON m.user_id = r.member_id
      LEFT JOIN ada_history.member_links l ON l.member_id = r.member_id
        AND l.source_id = 'hq000/AdaAcc' AND l.ada_code = m.member_code
        AND m.member_code ~ '^AR[0-9]{3}-[0-9]{6}$'
      LEFT JOIN ada_points.balance_cache b ON b.ada_code = l.ada_code`, [ids]));
  } catch {
    return new Map(ids.map(id => [id, unavailable('source_unavailable')]));
  }
  if (!Array.isArray(rows)) return new Map(ids.map(id => [id, unavailable('source_unavailable')]));
  const seen = new Set();
  const now = Date.now();
  for (const row of rows) {
    const id = typeof row.member_id === 'string' ? row.member_id.toLowerCase() : '';
    if (!results.has(id)) continue;
    if (seen.has(id)) { results.set(id, unavailable('source_unavailable')); continue; }
    seen.add(id);
    if (!AR_CODE.test(row.canonical_code || '') || row.mapped_code !== row.canonical_code || row.cache_code !== row.mapped_code) continue;
    results.set(id, balanceResult(row, now, maximumAgeSeconds));
  }
  return results;
}

async function readMemberBalance(db, memberId) {
  const balances = await readMemberBalances(db, [memberId]);
  return balances.get(memberId.toLowerCase());
}

// Unlike the strict canonical reader, this explicitly supports DB-owned legacy
// profiles. No client-supplied code is stripped or used to choose another owner.
async function readProfileBalances(db, values) {
  const ids = memberIds(values);
  const isEnabled = enabled();
  const result = new Map(ids.map(id => [id, unavailable(isEnabled ? 'unknown' : 'disabled')]));
  if (!isEnabled || !ids.length) return result;
  const age = maxAgeSeconds();
  let rows;
  try {
    ({ rows } = await db.query(`WITH requested AS (SELECT unnest($1::uuid[]) AS member_id), resolved AS (
      SELECT r.member_id, COALESCE(l.ada_code, c.ada_code) AS resolved_code
      FROM requested r LEFT JOIN public.member_profiles m ON m.user_id = r.member_id
      LEFT JOIN ada_history.member_links l ON l.member_id = r.member_id
        AND l.source_id = 'hq000/AdaAcc' AND l.ada_code = CASE
          WHEN m.member_code ~ '^AR[0-9]{3}-[0-9]{6}$' THEN m.member_code
          WHEN left(m.member_code,4) = 'ADA-' THEN substring(m.member_code from 5) END
      LEFT JOIN ada_history.customers c ON m.user_id IS NULL AND c.directory_id = r.member_id
        AND c.source_id = 'hq000/AdaAcc' AND c.ada_code <> '0'
        AND NOT EXISTS (SELECT 1 FROM ada_history.member_links existing
          WHERE existing.source_id=c.source_id AND existing.ada_code=c.ada_code)
    ) SELECT r.member_id::text AS member_id, r.resolved_code, b.ada_code AS cache_code,
      b.balance::text AS balance_exact, b.observed_at, b.state
      FROM resolved r LEFT JOIN ada_points.balance_cache b ON b.ada_code=r.resolved_code`, [ids]));
  } catch { return new Map(ids.map(id => [id, unavailable('source_unavailable')])); }
  if (!Array.isArray(rows)) return new Map(ids.map(id => [id, unavailable('source_unavailable')]));
  const seen = new Set(), now = Date.now();
  for (const row of rows) {
    const id = typeof row.member_id === 'string' ? row.member_id.toLowerCase() : '';
    if (!result.has(id)) continue;
    if (seen.has(id)) { result.set(id, unavailable('source_unavailable')); continue; }
    seen.add(id);
    if (!NATIVE_CODE.test(row.resolved_code || '') || row.cache_code !== row.resolved_code) continue;
    result.set(id, balanceResult(row, now, age));
  }
  return result;
}

async function readProfileBalance(db, memberId) {
  const result = await readProfileBalances(db, [memberId]);
  return result.get(memberId.toLowerCase());
}

function publicFields(result) {
  return { pointsAvailable: Boolean(result?.available), pointsSource: 'ada',
    pointsStatus: result?.available ? 'available' : result?.reason || 'source_unavailable',
    pointsObservedAt: result?.observedAt || null, balanceExact: result?.balanceExact ?? null };
}

function receiptIdentity(branchCode, receiptNo, memberId) {
  memberIds([memberId]);
  const branch = typeof branchCode === 'string' ? branchCode.trim().toUpperCase() : '';
  const doc = typeof receiptNo === 'string' ? receiptNo.trim().toUpperCase() : '';
  if (!/^[0-9]{3}$/.test(branch) || !/^[A-Z0-9][A-Z0-9._\/-]{0,99}$/.test(doc)) throw invalid('INVALID_ADA_RECEIPT');
  return { branch, doc, member: memberId.toLowerCase() };
}

function failure(code, message, status = 503) {
  return Object.assign(new Error(message), { code, status });
}

// Worker-owned native_events are unique, reconciled native events. Their points
// record the original award; contribution/active affect current balance only.
// This function never awards new points, even when the receipt has no native row.
async function readReceiptPoints(db, { branchCode, receiptNo, memberId }) {
  const { branch, doc, member } = receiptIdentity(branchCode, receiptNo, memberId);
  if (!enabled()) throw failure('ADA_POINTS_DISABLED', 'Ada point authority is not enabled.');
  let rows;
  try {
    ({ rows } = await db.query(`SELECT e.event_key, e.ada_code, e.card_type,
      e.points::text AS points_exact, e.state, e.active,
      COALESCE(l.member_id,c.directory_id)::text AS owner_member_id
      FROM ada_points.native_events e
      LEFT JOIN ada_history.member_links l ON l.source_id='hq000/AdaAcc' AND l.ada_code=e.ada_code
      LEFT JOIN ada_history.customers c ON c.source_id='hq000/AdaAcc' AND c.ada_code=e.ada_code
      WHERE e.origin_branch=$1 AND e.doc_no=$2 AND e.card_type='1'
      ORDER BY e.event_key`, [branch, doc]));
  } catch { throw failure('ADA_POINTS_SOURCE_UNAVAILABLE', 'คะแนนจาก Ada ยังไม่พร้อม กรุณาลองใหม่'); }
  if (!Array.isArray(rows)) throw failure('ADA_POINTS_SOURCE_UNAVAILABLE', 'คะแนนจาก Ada ยังไม่พร้อม กรุณาลองใหม่');
  if (rows.some(row => row.owner_member_id?.toLowerCase() !== member)) {
    throw failure('BILL_OWNER_CONFLICT', 'บิลนี้ผูกกับสมาชิกอื่นใน Ada หรือยังยืนยันเจ้าของไม่ได้', 409);
  }
  if (rows.some(row => row.state !== 'ready')) throw failure('ADA_POINTS_EVENT_REVIEW', 'รายการคะแนน Ada นี้ยังต้องตรวจสอบ', 409);
  const balance = await readProfileBalance(db, member);
  if (!balance.available) throw failure('ADA_POINTS_SOURCE_UNAVAILABLE', 'คะแนนจาก Ada ยังไม่พร้อม กรุณาลองใหม่');
  const seen = new Set(); let points = 0n;
  for (const row of rows) {
    if (!/^[a-f0-9]{64}$/.test(row.event_key || '') || seen.has(row.event_key) || !/^[0-9]+$/.test(row.points_exact || '')) {
      throw failure('ADA_POINTS_EVENT_INVALID', 'รายการคะแนน Ada นี้ยังต้องตรวจสอบ');
    }
    seen.add(row.event_key);
    points += BigInt(row.points_exact);
  }
  if (points > 2147483647n) throw failure('ADA_POINTS_AWARD_UNREPRESENTABLE', 'รายการคะแนน Ada เกินขอบเขตประวัติที่รองรับ');
  return { ...publicFields(balance), balance: balance.balance, awardedPoints: Number(points),
    awardedPointsExact: points.toString(), pointsPolicy: 'ada-native-recorded', pointsCredited: false,
    pointsStatus: rows.length ? 'recorded_by_ada' : 'not_recorded_by_ada' };
}

// A history page uses one bounded native-event query plus one balance lookup,
// rather than querying each receipt separately. This never changes old claims.
async function readReceiptPointSummaries(db, memberId, receipts) {
  memberIds([memberId]);
  if (!Array.isArray(receipts) || receipts.length>500) throw invalid('INVALID_ADA_RECEIPTS');
  const identities=receipts.map(row=>receiptIdentity(row.branchCode,row.receiptNo,memberId));
  const unique=new Map(identities.map(row=>[row.branch+'|'+row.doc,row]));
  if (!unique.size) return new Map();
  const balance=await readProfileBalance(db,memberId);
  const missing=reason=>({...publicFields(unavailable(reason)),awardedPoints:null,awardedPointsExact:null,pointsCredited:false});
  const results=new Map([...unique.keys()].map(key=>[key,balance.available?null:missing(balance.reason)]));
  if (!balance.available) return results;
  let rows;
  try {
    ({rows}=await db.query(`WITH requested AS (
      SELECT * FROM unnest($1::text[],$2::text[]) AS r(branch_code,doc_no)
    ) SELECT r.branch_code,r.doc_no,e.event_key,e.points::text AS points_exact,e.state,
      COALESCE(l.member_id,c.directory_id)::text AS owner_member_id
      FROM requested r LEFT JOIN ada_points.native_events e
        ON e.origin_branch=r.branch_code AND e.doc_no=r.doc_no AND e.card_type='1'
      LEFT JOIN ada_history.member_links l ON l.source_id='hq000/AdaAcc' AND l.ada_code=e.ada_code
      LEFT JOIN ada_history.customers c ON c.source_id='hq000/AdaAcc' AND c.ada_code=e.ada_code
      ORDER BY r.branch_code,r.doc_no,e.event_key`,[[...unique.values()].map(r=>r.branch),[...unique.values()].map(r=>r.doc)]));
  } catch {return new Map([...unique.keys()].map(key=>[key,missing('source_unavailable')]));}
  if (!Array.isArray(rows)) return new Map([...unique.keys()].map(key=>[key,missing('source_unavailable')]));
  const grouped=new Map([...unique.keys()].map(key=>[key,[]]));
  for (const row of rows) if(grouped.has(row.branch_code+'|'+row.doc_no)) grouped.get(row.branch_code+'|'+row.doc_no).push(row);
  for(const [key,group] of grouped){
    if(!group.length){results.set(key,missing('source_unavailable'));continue;}
    const events=group.filter(row=>row.event_key!=null);
    const seen=new Set();let total=0n,reason=null;
    for(const row of events){
      if(row.owner_member_id?.toLowerCase()!==memberId.toLowerCase()){reason='owner_conflict';break;}
      if(row.state!=='ready'){reason='event_review';break;}
      if(!/^[a-f0-9]{64}$/.test(row.event_key||'') || seen.has(row.event_key) || !/^[0-9]+$/.test(row.points_exact||'')){reason='source_unavailable';break;}
      seen.add(row.event_key);total+=BigInt(row.points_exact);
    }
    results.set(key,reason?missing(reason):{...publicFields(balance),awardedPoints:safeNumber(total.toString()),
      awardedPointsExact:total.toString(),pointsStatus:events.length?'recorded_by_ada':'not_recorded_by_ada',pointsCredited:false});
  }
  return results;
}

async function readPointHistory(db, memberId) {
  const balance = await readProfileBalance(db, memberId);
  if (!balance.available) return { ...publicFields(balance), balance: null, items: [] };
  try {
    const { rows } = await db.query(`SELECT e.event_key AS id, e.doc_no AS reference_id,
      e.points::text AS original_points, e.card_type, e.active, e.state, e.contribution::text AS contribution,
      e.business_payload->>'FDPntDate' AS native_date,
      e.business_payload->>'FDDateIns' AS native_insert_date,
      e.business_payload->>'FTTimeIns' AS native_insert_time
      FROM ada_points.native_events e
      LEFT JOIN ada_history.member_links l ON l.source_id='hq000/AdaAcc' AND l.ada_code=e.ada_code
      LEFT JOIN ada_history.customers c ON c.source_id='hq000/AdaAcc' AND c.ada_code=e.ada_code
      WHERE COALESCE(l.member_id,c.directory_id)=$1::uuid
      ORDER BY e.business_payload->>'FDPntDate' DESC NULLS LAST,e.event_key LIMIT 500`, [memberId]);
    if (!Array.isArray(rows) || rows.some(row => row.state !== 'ready')) throw Error('Native point history is pending review.');
    const items = rows.map(row => {
      if (!/^[0-9]+$/.test(row.original_points || '') || normalizedDecimal(row.contribution || '') == null) throw Error('Invalid native point history.');
      const exact = normalizedDecimal((row.card_type === '2' ? '-' : '') + row.original_points);
      // Business date is not evidence of when a new award was made. Only an
      // explicit Ada insertion date+time may drive the recent-earn notification.
      const date = /^(\d{4}-\d{2}-\d{2})(?:T.*)?$/.exec(row.native_insert_date || '')?.[1];
      const time = /^\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(row.native_insert_time || '') ? row.native_insert_time : null;
      const inserted = date && time ? new Date(`${date}T${time}+07:00`) : null;
      return { id: row.id, reference_id: row.reference_id,
        amount: safeNumber(exact), amountExact: exact,
        type: row.card_type === '1' ? 'purchase' : row.card_type === '2' ? 'redeem' : 'adjustment',
        active: row.active, contributionExact: row.contribution, businessDate: row.native_date || null,
        created_at: inserted && Number.isFinite(inserted.getTime()) ? inserted.toISOString() : null,
        created_by: 'Ada', note: 'รายการที่ Ada บันทึก', pointsSource: 'ada' };
    });
    return { ...publicFields(balance), balance: balance.balance, items };
  } catch { return { ...publicFields(unavailable('source_unavailable')), balance: null, items: [] }; }
}

module.exports = { enabled, readCodeBalance, readMemberBalance, readMemberBalances,
  readProfileBalance, readProfileBalances, publicFields, readReceiptPoints, readReceiptPointSummaries, readPointHistory };
