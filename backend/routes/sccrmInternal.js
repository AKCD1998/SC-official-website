const express = require("express");
const pool = require("../db");
const { createId, hashOpaqueToken, requireEnv } = require("../lib/sccrm");
const {
  buildSaleEventRecord,
  buildRefundEventRecord,
  buildSourceEventKey,
  claimTokenExpiryDate,
  createClaimToken,
  hashClaimToken,
  normalizeText,
  toNumber,
} = require("../lib/sccrmCrm");

const router = express.Router();

function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

function requireInternalToken(req, res, next) {
  try {
    const expected = requireEnv("SCCRM_INTERNAL_API_TOKEN");
    const incoming = normalizeText(req.headers["x-internal-token"] || req.headers.authorization?.replace(/^Bearer\s+/i, ""));
    if (!incoming || incoming !== expected) {
      return jsonError(res, 401, "Unauthorized.");
    }
    return next();
  } catch (error) {
    return jsonError(res, 500, error.message || "Internal auth is not configured.");
  }
}

async function queryOne(sql, params) {
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
}

async function queryOneOn(executor, sql, params) {
  const result = await executor.query(sql, params);
  return result.rows[0] || null;
}

async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function upsertSaleEvent(client, sale) {
  const existing = await client.query(
    `SELECT id, claim_status FROM crm_pos_sale_events WHERE source_event_key = $1`,
    [sale.source_event_key]
  );

  let saleEventId = existing.rows[0]?.id || sale.id;

  await client.query(
    `INSERT INTO crm_pos_sale_events
       (id, branch_code, pos_code, doc_no, doc_type, sale_at, cashier_code,
        gross_total, net_total, paid_total, ada_customer_code, claim_status,
        source_system, source_event_key, source_synced_at, tender_rows, raw_payload, created_at, updated_at)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, COALESCE($12, 'unclaimed'),
        $13, $14, $15, $16::jsonb, $17::jsonb, NOW(), NOW())
     ON CONFLICT (source_event_key) DO UPDATE SET
       branch_code = EXCLUDED.branch_code,
       pos_code = EXCLUDED.pos_code,
       doc_no = EXCLUDED.doc_no,
       doc_type = EXCLUDED.doc_type,
       sale_at = EXCLUDED.sale_at,
       cashier_code = EXCLUDED.cashier_code,
       gross_total = EXCLUDED.gross_total,
       net_total = EXCLUDED.net_total,
       paid_total = EXCLUDED.paid_total,
       ada_customer_code = EXCLUDED.ada_customer_code,
       source_system = EXCLUDED.source_system,
       source_synced_at = EXCLUDED.source_synced_at,
       tender_rows = EXCLUDED.tender_rows,
       raw_payload = EXCLUDED.raw_payload,
       updated_at = NOW()`,
    [
      saleEventId,
      sale.branch_code,
      sale.pos_code,
      sale.doc_no,
      sale.doc_type,
      sale.sale_at,
      sale.cashier_code,
      sale.gross_total,
      sale.net_total,
      sale.paid_total,
      sale.ada_customer_code,
      existing.rows[0]?.claim_status || "unclaimed",
      sale.source_system,
      sale.source_event_key,
      sale.source_synced_at,
      JSON.stringify(sale.tender_rows || []),
      JSON.stringify(sale.raw_payload || {}),
    ]
  );

  await client.query(`DELETE FROM crm_pos_sale_line_events WHERE sale_event_id = $1`, [saleEventId]);
  for (const line of sale.line_rows) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO crm_pos_sale_line_events
         (id, sale_event_id, line_no, product_code, barcode, qty, unit_code, unit_name, net_amount, discount_amount, lot_no, expiry_date, raw_payload, created_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, NOW())`,
      [
        createId(),
        saleEventId,
        line.line_no,
        line.product_code,
        line.barcode,
        line.qty,
        line.unit_code,
        line.unit_name,
        line.net_amount,
        line.discount_amount,
        line.lot_no,
        line.expiry_date,
        JSON.stringify(line.raw_payload || {}),
      ]
    );
  }

  return saleEventId;
}

async function maybeCreateReversal(client, refundEventId) {
  const refund = await queryOneOn(
    client,
    `SELECT r.id, r.refund_total, r.branch_code, r.original_doc_no,
            s.id AS sale_event_id, a.id AS award_id, a.customer_account_id, a.points_awarded
     FROM crm_pos_refund_events r
     JOIN crm_pos_sale_events s
       ON s.branch_code = r.branch_code AND s.doc_no = r.original_doc_no
     JOIN crm_loyalty_awards a
       ON a.sale_event_id = s.id
     WHERE r.id = $1`,
    [refundEventId]
  );
  if (!refund) return null;

  const existing = await queryOneOn(
    client,
    `SELECT id FROM crm_loyalty_reversals WHERE refund_event_id = $1`,
    [refundEventId]
  );
  if (existing) return existing.id;

  const sale = await queryOneOn(
    client,
    `SELECT paid_total FROM crm_pos_sale_events WHERE id = $1`,
    [refund.sale_event_id]
  );
  const saleTotal = Math.max(0, toNumber(sale?.paid_total, 0));
  const refundTotal = Math.max(0, toNumber(refund.refund_total, 0));
  const ratio = saleTotal > 0 ? Math.min(1, refundTotal / saleTotal) : 0;
  const pointsReversed = Math.max(1, Math.min(refund.points_awarded, Math.floor(refund.points_awarded * ratio || 0)));

  const ledgerId = createId();
  await client.query(
    `INSERT INTO point_ledger (id, user_id, amount, type, reference_id, note, created_by, created_at)
     VALUES ($1, $2, $3, 'adjustment', $4, $5, 'system', NOW())`,
    [ledgerId, refund.customer_account_id, -pointsReversed, refundEventId, `Refund reversal for ${refund.original_doc_no}`]
  );

  const reversalId = createId();
  await client.query(
    `INSERT INTO crm_loyalty_reversals
       (id, refund_event_id, customer_account_id, points_reversed, original_award_id, ledger_entry_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [reversalId, refundEventId, refund.customer_account_id, pointsReversed, refund.award_id, ledgerId]
  );
  return reversalId;
}

async function upsertRefundEvent(client, refund) {
  const existing = await client.query(
    `SELECT id FROM crm_pos_refund_events WHERE source_event_key = $1`,
    [refund.source_event_key]
  );
  const refundEventId = existing.rows[0]?.id || refund.id;

  await client.query(
    `INSERT INTO crm_pos_refund_events
       (id, branch_code, pos_code, refund_doc_no, original_doc_no, refund_at, cashier_code,
        refund_total, source_system, source_event_key, source_synced_at, tender_rows, raw_payload, created_at, updated_at)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12::jsonb, $13::jsonb, NOW(), NOW())
     ON CONFLICT (source_event_key) DO UPDATE SET
       branch_code = EXCLUDED.branch_code,
       pos_code = EXCLUDED.pos_code,
       refund_doc_no = EXCLUDED.refund_doc_no,
       original_doc_no = EXCLUDED.original_doc_no,
       refund_at = EXCLUDED.refund_at,
       cashier_code = EXCLUDED.cashier_code,
       refund_total = EXCLUDED.refund_total,
       source_system = EXCLUDED.source_system,
       source_synced_at = EXCLUDED.source_synced_at,
       tender_rows = EXCLUDED.tender_rows,
       raw_payload = EXCLUDED.raw_payload,
       updated_at = NOW()`,
    [
      refundEventId,
      refund.branch_code,
      refund.pos_code,
      refund.refund_doc_no,
      refund.original_doc_no,
      refund.refund_at,
      refund.cashier_code,
      refund.refund_total,
      refund.source_system,
      refund.source_event_key,
      refund.source_synced_at,
      JSON.stringify(refund.tender_rows || []),
      JSON.stringify(refund.raw_payload || {}),
    ]
  );

  await client.query(`DELETE FROM crm_pos_refund_line_events WHERE refund_event_id = $1`, [refundEventId]);
  for (const line of refund.line_rows) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO crm_pos_refund_line_events
         (id, refund_event_id, line_no, product_code, qty, net_amount, lot_no, expiry_date, raw_payload, created_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())`,
      [
        createId(),
        refundEventId,
        line.line_no,
        line.product_code,
        line.qty,
        line.net_amount,
        line.lot_no,
        line.expiry_date,
        JSON.stringify(line.raw_payload || {}),
      ]
    );
  }

  await maybeCreateReversal(client, refundEventId);
  return refundEventId;
}

router.use(requireInternalToken);

router.post("/crm/pos/sales", async (req, res) => {
  try {
    const rawRecords = Array.isArray(req.body?.records) ? req.body.records : [req.body];
    const records = rawRecords.filter((item) => item && Object.keys(item).length > 0).map(buildSaleEventRecord);
    if (records.length === 0) return jsonError(res, 400, "records are required.");

    await withTransaction(async (client) => {
      for (const sale of records) {
        // eslint-disable-next-line no-await-in-loop
        await upsertSaleEvent(client, sale);
      }
    });

    return res.json({ ok: true, accepted: records.length });
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed to mirror sale events.");
  }
});

router.post("/crm/pos/refunds", async (req, res) => {
  try {
    const rawRecords = Array.isArray(req.body?.records) ? req.body.records : [req.body];
    const records = rawRecords.filter((item) => item && Object.keys(item).length > 0).map(buildRefundEventRecord);
    if (records.length === 0) return jsonError(res, 400, "records are required.");

    await withTransaction(async (client) => {
      for (const refund of records) {
        // eslint-disable-next-line no-await-in-loop
        await upsertRefundEvent(client, refund);
      }
    });

    return res.json({ ok: true, accepted: records.length });
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed to mirror refund events.");
  }
});

router.post("/crm/pos/claim-token", async (req, res) => {
  try {
    const branchCode = normalizeText(req.body?.branch_code || req.body?.branchCode).toUpperCase();
    const docNo = normalizeText(req.body?.doc_no || req.body?.docNo).toUpperCase();
    if (!branchCode || !docNo) return jsonError(res, 400, "branch_code and doc_no are required.");

    const sale = await queryOne(
      `SELECT id, branch_code, doc_no, claim_status, source_event_key
       FROM crm_pos_sale_events
       WHERE branch_code = $1 AND doc_no = $2`,
      [branchCode, docNo]
    );
    if (!sale) return jsonError(res, 404, "Sale event not found.");

    const existingClaim = await queryOne(
      `SELECT id FROM crm_sale_claims WHERE sale_event_id = $1`,
      [sale.id]
    );
    if (existingClaim) return jsonError(res, 409, "Sale already claimed.");

    const plainToken = createClaimToken();
    const tokenId = createId();
    await pool.query(
      `INSERT INTO crm_sale_claim_tokens
         (id, branch_code, doc_no, token_hash, source_event_key, expires_at, issued_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [tokenId, branchCode, docNo, hashClaimToken(plainToken), sale.source_event_key || buildSourceEventKey("sale", branchCode, docNo), claimTokenExpiryDate()]
    );

    return res.json({ ok: true, claim_token: plainToken, expires_at: claimTokenExpiryDate() });
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed to create claim token.");
  }
});

module.exports = router;
