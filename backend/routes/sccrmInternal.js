const express = require("express");
const pool = require("../db");
const { createId, hashOpaqueToken, requireEnv } = require("../lib/sccrm");
const {
  buildSaleEventRecord,
  buildRefundEventRecord,
  buildLiveSaleEventRecord,
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

async function queryValueOn(executor, sql, params, key) {
  const row = await queryOneOn(executor, sql, params);
  return row ? row[key] : null;
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

async function ensureAwardMirrorForLoyaltyClaim(client, refundEventId) {
  const refund = await queryOneOn(
    client,
    `SELECT id, branch_code, original_doc_no
       FROM crm_pos_refund_events
      WHERE id = $1`,
    [refundEventId]
  );
  if (!refund) return null;

  const loyaltyClaim = await queryOneOn(
    client,
    `SELECT lc.id,
            lc.receipt_no,
            lc.branch_code,
            lc.cashier_staff_code,
            lc.sold_at,
            lc.total_amount,
            lc.user_id AS customer_account_id,
            lc.awarded_points,
            pl.id AS ledger_entry_id
       FROM loyalty_claims lc
       LEFT JOIN point_ledger pl
         ON pl.reference_id = lc.id
        AND pl.user_id = lc.user_id::uuid
        AND pl.type = 'purchase'
      WHERE UPPER(BTRIM(lc.branch_code)) = $1
        AND UPPER(BTRIM(lc.receipt_no)) = $2
      ORDER BY lc.created_at DESC
      LIMIT 1`,
    [refund.branch_code, refund.original_doc_no]
  );
  if (!loyaltyClaim || Number(loyaltyClaim.awarded_points || 0) <= 0 || !loyaltyClaim.ledger_entry_id) {
    return null;
  }

  const sourceEventKey = buildSourceEventKey("sale", loyaltyClaim.branch_code, loyaltyClaim.receipt_no);
  const itemRows = await client.query(
    `SELECT product_code, product_name, qty, unit_price, line_total
       FROM loyalty_claim_items
      WHERE claim_id = $1
      ORDER BY created_at ASC, id ASC`,
    [loyaltyClaim.id]
  );

  const saleEventId = await upsertSaleEvent(client, {
    id: createId(),
    branch_code: normalizeText(loyaltyClaim.branch_code).toUpperCase(),
    pos_code: null,
    doc_no: normalizeText(loyaltyClaim.receipt_no).toUpperCase(),
    doc_type: "1",
    sale_at: loyaltyClaim.sold_at || new Date().toISOString(),
    cashier_code: normalizeText(loyaltyClaim.cashier_staff_code) || null,
    gross_total: toNumber(loyaltyClaim.total_amount, 0),
    net_total: toNumber(loyaltyClaim.total_amount, 0),
    paid_total: toNumber(loyaltyClaim.total_amount, 0),
    ada_customer_code: null,
    source_system: "SCCRMonPOS",
    source_event_key: sourceEventKey,
    source_synced_at: new Date().toISOString(),
    tender_rows: [],
    raw_payload: {
      mirrored_from: "loyalty_claims",
      loyalty_claim_id: loyaltyClaim.id,
    },
    line_rows: itemRows.rows.map((item, index) => ({
      line_no: index + 1,
      product_code: normalizeText(item.product_code) || null,
      barcode: null,
      qty: toNumber(item.qty, 0),
      unit_code: null,
      unit_name: null,
      net_amount: toNumber(item.line_total, 0),
      discount_amount: 0,
      lot_no: null,
      expiry_date: null,
      raw_payload: item,
    })),
  });

  const existingAward = await queryOneOn(
    client,
    `SELECT id
       FROM crm_loyalty_awards
      WHERE sale_event_id = $1`,
    [saleEventId]
  );
  if (!existingAward) {
    await client.query(
      `INSERT INTO crm_loyalty_awards
         (id, sale_event_id, customer_account_id, points_awarded, promotion_snapshot, ledger_entry_id, created_at)
       VALUES ($1, $2, $3, $4, '[]'::jsonb, $5, NOW())`,
      [createId(), saleEventId, loyaltyClaim.customer_account_id, Number(loyaltyClaim.awarded_points || 0), loyaltyClaim.ledger_entry_id]
    );
  }

  return saleEventId;
}

async function maybeCreateReversal(client, refundEventId) {
  const existing = await queryOneOn(
    client,
    `SELECT id, points_reversed
       FROM crm_loyalty_reversals
      WHERE refund_event_id = $1`,
    [refundEventId]
  );
  if (existing) {
    return {
      status: "already_reversed",
      reversalId: existing.id,
      pointsReversed: Number(existing.points_reversed || 0),
      reason: "refund already reversed",
    };
  }

  const loadRefundContext = async () => queryOneOn(
    client,
    `SELECT r.id, r.refund_total, r.branch_code, r.original_doc_no, r.refund_doc_no,
            s.id AS sale_event_id, s.paid_total,
            a.id AS award_id, a.customer_account_id, a.points_awarded
       FROM crm_pos_refund_events r
       JOIN crm_pos_sale_events s
         ON s.branch_code = r.branch_code AND s.doc_no = r.original_doc_no
       JOIN crm_loyalty_awards a
         ON a.sale_event_id = s.id
      WHERE r.id = $1`,
    [refundEventId]
  );

  let refund = await loadRefundContext();
  if (!refund) {
    await ensureAwardMirrorForLoyaltyClaim(client, refundEventId);
    refund = await loadRefundContext();
  }
  if (!refund) {
    return {
      status: "skipped",
      pointsReversed: 0,
      reason: "original sale was not claimed",
    };
  }

  const sale = await queryOneOn(
    client,
    `SELECT paid_total FROM crm_pos_sale_events WHERE id = $1`,
    [refund.sale_event_id]
  );
  const saleTotal = Math.max(0, toNumber(sale?.paid_total, 0));
  const refundTotal = Math.max(0, toNumber(refund.refund_total, 0));
  const ratio = saleTotal > 0 ? Math.min(1, refundTotal / saleTotal) : 0;
  const requestedPoints = Math.min(Number(refund.points_awarded || 0), Math.floor(Number(refund.points_awarded || 0) * ratio || 0));
  const alreadyReversed = Number(
    await queryValueOn(
      client,
      `SELECT COALESCE(SUM(points_reversed), 0) AS total
         FROM crm_loyalty_reversals
        WHERE original_award_id = $1`,
      [refund.award_id],
      "total"
    ) || 0
  );
  const availablePoints = Math.max(0, Number(refund.points_awarded || 0) - alreadyReversed);
  const pointsReversed = Math.min(availablePoints, requestedPoints);
  if (pointsReversed <= 0) {
    return {
      status: "skipped",
      pointsReversed: 0,
      reason: availablePoints <= 0 ? "all claim points already reversed" : "refund amount does not reach 1 point threshold",
    };
  }

  const ledgerId = createId();
  await client.query(
    `INSERT INTO point_ledger (id, user_id, amount, type, reference_id, note, created_by, created_at)
     VALUES ($1, $2, $3, 'adjustment', $4, $5, 'system', NOW())`,
    [ledgerId, refund.customer_account_id, -pointsReversed, refundEventId, `Refund reversal for ${refund.refund_doc_no || refund.original_doc_no}`]
  );

  const reversalId = createId();
  await client.query(
    `INSERT INTO crm_loyalty_reversals
       (id, refund_event_id, customer_account_id, points_reversed, original_award_id, ledger_entry_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [reversalId, refundEventId, refund.customer_account_id, pointsReversed, refund.award_id, ledgerId]
  );
  return {
    status: "reversed",
    reversalId,
    pointsReversed,
    reason: null,
  };
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

  const reversal = await maybeCreateReversal(client, refundEventId);
  return {
    refundEventId,
    refundDocNo: refund.refund_doc_no,
    originalDocNo: refund.original_doc_no,
    reversal,
  };
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

    const results = [];
    await withTransaction(async (client) => {
      for (const refund of records) {
        // eslint-disable-next-line no-await-in-loop
        results.push(await upsertRefundEvent(client, refund));
      }
    });

    return res.json({ ok: true, accepted: records.length, results });
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed to mirror refund events.");
  }
});

router.post("/crm/pos/sale-event", async (req, res) => {
  try {
    const branchCode = normalizeText(req.body?.branch_code).toUpperCase();
    const docNo = normalizeText(req.body?.doc_no).toUpperCase();
    if (!branchCode || !docNo) {
      return jsonError(res, 400, "branch_code and doc_no are required.");
    }
    if (typeof req.body?.grand_total !== "number") {
      return jsonError(res, 400, "grand_total must be a number.");
    }
    if (!Array.isArray(req.body?.items) || req.body.items.length === 0) {
      return jsonError(res, 400, "items must be a non-empty array.");
    }

    const sale = buildLiveSaleEventRecord(req.body);

    await withTransaction(async (client) => {
      await upsertSaleEvent(client, sale);
    });

    return res.json({
      ok: true,
      branch_code: branchCode,
      doc_no: docNo,
      source_event_key: sale.source_event_key,
    });
  } catch (error) {
    return jsonError(res, 500, error.message || "Failed to register sale event.");
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
