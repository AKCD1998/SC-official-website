const pool = require('../db');
const { parseHistoryCursor, makeHistoryCursor, mapPurchase } = require('./purchaseHistory');
function normalizeDocRef(value) { return String(value || '').trim().toUpperCase(); }
async function queryOne(sql, params) { return (await pool.query(sql, params)).rows[0] || null; }
async function getMemberPurchaseHistory(memberId, query = {}) {

  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 500);
  const cursor=parseHistoryCursor(query.cursor);

  // Member must exist
  const member = await queryOne(
      `SELECT u.id FROM users u JOIN member_profiles m ON m.user_id = u.id WHERE u.id = $1::uuid`,
      [memberId],
    );
  if (!member) throw Object.assign(new Error("Member not found."), { status: 404 });

  const claimsResult = await pool.query(
      `SELECT id, receipt_no, branch_code, sold_at, total_amount, awarded_points, created_at,
    cashier_staff_code,receipt_total_amount,receipt_snapshot,
    COALESCE(sold_at,created_at)::text AS sort_sold_at,created_at::text AS sort_created_at
       FROM loyalty_claims
        WHERE user_id = $1
        ${cursor?'AND (COALESCE(sold_at,created_at),created_at,id)<($3::timestamptz,$4::timestamptz,$5::text)':''}
        ORDER BY COALESCE(sold_at, created_at) DESC, created_at DESC,id DESC
        LIMIT $2`,
      [memberId, limit+1,...(cursor?[cursor.soldAt,cursor.createdAt,cursor.id]:[])],
    );
  const hasMore=claimsResult.rows.length>limit;
  const claims = claimsResult.rows.slice(0,limit);
  const nextCursor=hasMore?makeHistoryCursor(claims[claims.length-1]):null;
  if (claims.length === 0) {
  return { ok: true, memberId, purchases: [],hasMore:false,nextCursor:null };
  }

  // Line items for all claims in one query.
  const claimIds = claims.map((c) => c.id);
  const itemsResult = await pool.query(
      `SELECT claim_id, product_code, product_name, qty, unit_price, line_total
       FROM loyalty_claim_items
        WHERE claim_id = ANY($1)
        ORDER BY created_at ASC, id ASC`,
      [claimIds],
    );
  const itemsByClaim = new Map();
  for (const it of itemsResult.rows) {
  if (!itemsByClaim.has(it.claim_id)) itemsByClaim.set(it.claim_id, []);
      itemsByClaim.get(it.claim_id).push({
      productCode: it.product_code,
      productName: it.product_name,
      qty: Number(it.qty || 0),
      unitPrice: Number(it.unit_price || 0),
      lineTotal: Number(it.line_total || 0),
      });
  }

  // Returns: refund events matched by branch_code + original_doc_no = receipt_no.
  const receiptKeys = claims.map((c) => normalizeDocRef(c.receipt_no));
  const refundsResult = await pool.query(
      `SELECT r.id, r.branch_code, r.original_doc_no, r.refund_doc_no, r.refund_at, r.refund_total,
  COALESCE((SELECT SUM(rl.qty) FROM crm_pos_refund_line_events rl WHERE rl.refund_event_id = r.id), 0) AS returned_qty,
  COALESCE((SELECT SUM(rev.points_reversed) FROM crm_loyalty_reversals rev WHERE rev.refund_event_id = r.id), 0) AS points_reversed
       FROM crm_pos_refund_events r
        WHERE UPPER(BTRIM(r.original_doc_no)) = ANY($1)
        ORDER BY r.refund_at ASC, r.created_at ASC`,
      [receiptKeys],
    );
  const returnsByKey = new Map();
  for (const r of refundsResult.rows) {
  const key = normalizeDocRef(r.branch_code) + "|" + normalizeDocRef(r.original_doc_no);
  if (!returnsByKey.has(key)) returnsByKey.set(key, []);
  returnsByKey.get(key).push({
      refundDocNo: r.refund_doc_no,
      refundedAt: r.refund_at,
      refundTotal: Number(r.refund_total || 0),
  returnedQty: Number(r.returned_qty || 0),
      pointsReversed: Number(r.points_reversed || 0),
      });
  }

  const purchases = claims.map((c) => {
  const key = normalizeDocRef(c.branch_code) + "|" + normalizeDocRef(c.receipt_no);
  return mapPurchase(c,itemsByClaim.get(c.id)||[],returnsByKey.get(key)||[]);
  });

  return { ok: true, memberId, purchases,hasMore,nextCursor };

}
module.exports = { getMemberPurchaseHistory };
