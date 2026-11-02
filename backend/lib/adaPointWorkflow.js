'use strict';

function conflict(code, message) { return Object.assign(new Error(message), { status: 409, code }); }

async function query(db, sql, values) {
  try { return await db.query(sql, values); }
  catch { throw Object.assign(new Error('ข้อมูลประวัติจาก Ada ยังไม่พร้อม กรุณาลองใหม่'), { status:503, code:'ADA_HISTORY_UNAVAILABLE' }); }
}
function requireStaffBranch(device, branchCode) {
  if (!device?.branch_code || String(device.branch_code).trim().toUpperCase() !== branchCode) {
    throw Object.assign(new Error('กรุณากำหนดสาขาของเครื่องให้ถูกต้องก่อนบันทึกบิล'), { status: 403, code: 'STAFF_BRANCH_REQUIRED' });
  }
}

// All Ada-mode claim channels acquire this transaction-scoped lock first. The
// existing native Ada award is not a claim and must never cause another credit.
async function guardReceipt(db, branchCode, receiptNo, memberId) {
  if (!/^[0-9]{3}$/.test(branchCode || '') || !/^[A-Z0-9][A-Z0-9._\/-]{0,99}$/.test(receiptNo || '') ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(memberId || '')) {
    throw Object.assign(new Error('Invalid Ada receipt identity.'), {status:400,code:'INVALID_ADA_RECEIPT'});
  }
  await query(db, 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`ada-points-receipt:${branchCode}:${receiptNo}`]);
  const { rows } = await query(db, `SELECT user_id::text AS owner_id FROM public.loyalty_claims
    WHERE branch_code=$1 AND receipt_no=$2
    UNION ALL SELECT a.customer_account_id::text FROM public.crm_loyalty_awards a
      JOIN public.crm_pos_sale_events s ON s.id=a.sale_event_id WHERE s.branch_code=$1 AND s.doc_no=$2
    UNION ALL SELECT c.customer_account_id::text FROM public.crm_sale_claims c
      JOIN public.crm_pos_sale_events s ON s.id=c.sale_event_id WHERE s.branch_code=$1 AND s.doc_no=$2
    UNION ALL SELECT t.user_id::text FROM public.transactions t WHERE t.pos_ref_id=$2`, [branchCode, receiptNo]);
  if (rows.some(row => !row.owner_id || row.owner_id.toLowerCase() !== memberId.toLowerCase())) {
    throw conflict('BILL_OWNER_CONFLICT', 'บิลนี้บันทึกให้สมาชิกอื่นแล้ว');
  }
  if (rows.length) throw conflict('ALREADY_RECORDED', 'บิลนี้บันทึกแล้ว');
}

async function nativeReceipt(db, branchCode, receiptNo, memberId = null, required = true) {
  const { rows } = await query(db, `SELECT r.doc_no, r.grand_total::text AS total_amount,
    ((r.sale_date + COALESCE(r.sale_time,'00:00:00'::time)) AT TIME ZONE 'Asia/Bangkok') AS sold_at,
    COALESCE(l.member_id,c.directory_id)::text AS owner_id
    FROM ada_history.receipts r JOIN ada_history.customers c
      ON c.source_id=r.source_id AND c.ada_code=r.customer_code
    LEFT JOIN ada_history.member_links l ON l.source_id=c.source_id AND l.ada_code=c.ada_code
    WHERE r.source_id='hq000/AdaAcc' AND r.branch_code=$1 AND r.doc_no=$2 AND r.doc_type='1'`, [branchCode, receiptNo]);
  if (!rows.length && !required) return null;
  if (rows.length !== 1 || !rows[0].owner_id) throw conflict('USE_ADA_POINTS', 'กรุณาเลือกสมาชิกและบันทึกแต้มผ่าน Ada ก่อน');
  const receipt = rows[0];
  if (memberId && receipt.owner_id.toLowerCase() !== memberId.toLowerCase()) throw conflict('BILL_OWNER_CONFLICT', 'เจ้าของบิลใน Ada ไม่ตรงกับสมาชิกที่เลือก');
  return receipt;
}

module.exports = { requireStaffBranch, guardReceipt, nativeReceipt };
