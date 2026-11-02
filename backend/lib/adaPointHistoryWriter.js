'use strict';
const { createId } = require('./sccrm');
const authority = require('./adaPointAuthority');
const workflow = require('./adaPointWorkflow');

// Caller owns the transaction and staff/customer authorization. Only an existing
// Ada receipt can back these older manual/import history paths. No point ledger,
// profile, mapping, native Ada row or tier is created or changed here.
async function recordNativeTransaction(db, { memberId = null, branchCode, receiptNo, source = 'manual', branchId = null, deviceId = null }) {
  if (!authority.enabled()) throw Object.assign(Error('Ada point authority is not enabled.'), { status: 503 });
  if (!/^[0-9]{3}$/.test(branchCode || '') || !/^[A-Z0-9][A-Z0-9._\/-]{0,99}$/.test(receiptNo || '') || !['manual','pos_import','online'].includes(source)) {
    throw Object.assign(Error('กรุณาใช้เลขบิลและสาขาที่ถูกต้องจาก Ada'), { status: 409, code: 'USE_ADA_POINTS' });
  }
  const receipt = await workflow.nativeReceipt(db, branchCode, receiptNo, memberId);
  const owner = receipt.owner_id;
  await workflow.guardReceipt(db, branchCode, receiptNo, owner);
  const existing = await db.query('SELECT id FROM public.users WHERE id=$1::uuid', [owner]);
  if (!existing.rows.length) throw Object.assign(Error('สมาชิก Ada นี้ยังไม่มีบัญชี SCCRM สำหรับรายการนำเข้า'), { status: 409, code: 'MEMBER_NOT_MATERIALIZED' });
  const quote = await authority.readReceiptPoints(db, { branchCode, receiptNo, memberId: owner });
  const transactionId = createId();
  await db.query(`INSERT INTO transactions
    (id,user_id,total_amount,point_earned,source,pos_ref_id,branch_id,staff_device_id,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [transactionId,owner,receipt.total_amount,quote.awardedPoints,source,receiptNo,branchId,deviceId,receipt.sold_at]);
  return { transactionId, memberId: owner, ...quote, historyRecorded: true };
}
module.exports = { recordNativeTransaction };
