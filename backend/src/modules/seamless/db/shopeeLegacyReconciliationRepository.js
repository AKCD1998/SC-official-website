const pool = require("../../../../db");
const { conflict, notFound } = require("../errors");
const { normalizeShopeeOrderNumber } = require("../shopeeOrderValidation");
const { normalizeShopeeShopCode } = require("../services/shopeeShops");
const { getTables } = require("../tables");

const LEGACY_SHOP_CODE = "legacy-unattributed";

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapLegacyRow(row) {
  return {
    currentStatus: row.current_status,
    decision: row.selected_shop_code ? {
      decisionStatus: row.decision_status,
      decisionSource: row.decision_source || "manual",
      evidenceStatus: row.evidence_status,
      reviewedAt: toIso(row.reviewed_at),
      selectedShopCode: normalizeShopeeShopCode(row.selected_shop_code),
      suggestedShopCode: normalizeShopeeShopCode(row.suggested_shop_code) || null,
    } : null,
    eventCount: Number(row.event_count || 0),
    firstEventAt: toIso(row.first_event_at),
    lastEventAt: toIso(row.last_event_at),
    orderNumber: normalizeShopeeOrderNumber(row.order_number),
    items: (Array.isArray(row.items) ? row.items : []).map((item) => ({
      name: String(item?.name || "").trim(),
      variant: String(item?.variant || "").trim(),
      quantity: Number.isFinite(Number(item?.quantity)) ? Number(item.quantity) : null,
    })),
    sourceEvents: (row.source_events || []).map((event) => ({
      eventType: event.eventType,
      gmailMessageId: event.gmailMessageId,
      mailboxAccount: event.mailboxAccount,
      occurredAt: toIso(event.occurredAt),
    })),
  };
}

function buildDecisionFilter(status, decisionsTable) {
  if (status === "pending") return `${decisionsTable}.order_number IS NULL`;
  if (status === "reviewed") {
    return `${decisionsTable}.decision_status = 'reviewed'`;
  }
  if (status === "applied") {
    return `${decisionsTable}.decision_status = 'applied'`;
  }
  return null;
}

async function listLegacyOrders({ cursor = null, limit = 10, status = "pending" } = {}) {
  const tables = getTables();
  const params = [];
  const where = [`o.shop_code = '${LEGACY_SHOP_CODE}'`];
  const decisionFilter = buildDecisionFilter(
    status,
    "d",
  );
  if (decisionFilter) where.push(decisionFilter);

  if (cursor) {
    params.push(cursor.lastEventAt, cursor.orderNumber);
    where.push(`(o.last_event_at, o.order_number) < ($1::timestamptz, $2)`);
  }
  params.push(limit + 1);

  const result = await pool.query(
    `
      SELECT
        o.order_number,
        o.current_status,
        o.first_event_at,
        o.last_event_at,
        o.items,
        COUNT(e.id) AS event_count,
        jsonb_agg(
          jsonb_build_object(
            'eventType', e.event_type,
            'gmailMessageId', e.gmail_message_id,
            'mailboxAccount', e.mailbox_account,
            'occurredAt', e.occurred_at
          ) ORDER BY e.occurred_at ASC, e.id ASC
        ) AS source_events,
        d.selected_shop_code,
        d.suggested_shop_code,
        d.evidence_status,
        d.decision_source,
        d.decision_status,
        d.reviewed_at
      FROM ${tables.shopeeOrders} o
      JOIN ${tables.shopeeOrderEvents} e
        ON e.shop_code = o.shop_code AND e.order_number = o.order_number
      LEFT JOIN ${tables.shopeeLegacyReconciliationDecisions} d
        ON d.order_number = o.order_number
      WHERE ${where.join(" AND ")}
      GROUP BY
        o.order_number,
        o.current_status,
        o.first_event_at,
        o.last_event_at,
        o.items,
        d.selected_shop_code,
        d.suggested_shop_code,
        d.evidence_status,
        d.decision_source,
        d.decision_status,
        d.reviewed_at
      ORDER BY o.last_event_at DESC, o.order_number DESC
      LIMIT $${params.length}
    `,
    params,
  );

  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
  return { hasMore, orders: rows.map(mapLegacyRow) };
}

async function getLegacyOrder(orderNumber) {
  const tables = getTables();
  const rowResult = await pool.query(
    `
      SELECT
        o.order_number,
        o.current_status,
        o.first_event_at,
        o.last_event_at,
        o.items,
        COUNT(e.id) AS event_count,
        jsonb_agg(
          jsonb_build_object(
            'eventType', e.event_type,
            'gmailMessageId', e.gmail_message_id,
            'mailboxAccount', e.mailbox_account,
            'occurredAt', e.occurred_at
          ) ORDER BY e.occurred_at ASC, e.id ASC
        ) AS source_events,
        d.selected_shop_code,
        d.suggested_shop_code,
        d.evidence_status,
        d.decision_source,
        d.decision_status,
        d.reviewed_at
      FROM ${tables.shopeeOrders} o
      JOIN ${tables.shopeeOrderEvents} e
        ON e.shop_code = o.shop_code AND e.order_number = o.order_number
      LEFT JOIN ${tables.shopeeLegacyReconciliationDecisions} d
        ON d.order_number = o.order_number
      WHERE o.shop_code = $1 AND o.order_number = $2
      GROUP BY
        o.order_number,
        o.current_status,
        o.first_event_at,
        o.last_event_at,
        o.items,
        d.selected_shop_code,
        d.suggested_shop_code,
        d.evidence_status,
        d.decision_source,
        d.decision_status,
        d.reviewed_at
    `,
    [LEGACY_SHOP_CODE, orderNumber],
  );
  if (!rowResult.rows[0]) throw notFound("Legacy Shopee order not found.");
  return mapLegacyRow(rowResult.rows[0]);
}

async function saveDecision({ evidenceStatus, orderNumber, selectedShopCode, suggestedShopCode }) {
  const tables = getTables();
  const result = await pool.query(
    `
      INSERT INTO ${tables.shopeeLegacyReconciliationDecisions} (
        order_number,
        selected_shop_code,
        suggested_shop_code,
        evidence_status,
        decision_source,
        decision_status,
        reviewed_at,
        applied_at
      )
      SELECT o.order_number, $2, $3, $4, 'manual', 'reviewed', now(), NULL
      FROM ${tables.shopeeOrders} o
      WHERE o.shop_code = $1 AND o.order_number = $5
      ON CONFLICT (order_number) DO UPDATE SET
        selected_shop_code = EXCLUDED.selected_shop_code,
        suggested_shop_code = EXCLUDED.suggested_shop_code,
        evidence_status = EXCLUDED.evidence_status,
        decision_source = 'manual',
        decision_status = 'reviewed',
        reviewed_at = now(),
        applied_at = NULL
      RETURNING *
    `,
    [
      LEGACY_SHOP_CODE,
      selectedShopCode,
      suggestedShopCode || null,
      evidenceStatus,
      orderNumber,
    ],
  );
  if (!result.rows[0]) throw notFound("Legacy Shopee order not found.");
  return {
    decisionStatus: result.rows[0].decision_status,
    evidenceStatus: result.rows[0].evidence_status,
    orderNumber: normalizeShopeeOrderNumber(result.rows[0].order_number),
    reviewedAt: toIso(result.rows[0].reviewed_at),
    selectedShopCode: normalizeShopeeShopCode(result.rows[0].selected_shop_code),
    suggestedShopCode: normalizeShopeeShopCode(result.rows[0].suggested_shop_code) || null,
  };
}

function normalizeApplyAttributions(attributions) {
  if (!Array.isArray(attributions) || !attributions.length) {
    throw new Error("At least one legacy attribution is required.");
  }
  const seen = new Set();
  return attributions.map((attribution) => {
    const orderNumber = normalizeShopeeOrderNumber(attribution?.orderNumber);
    const targetShopCode = normalizeShopeeShopCode(attribution?.targetShopCode);
    if (!orderNumber || !targetShopCode || seen.has(orderNumber)) {
      throw new Error("Legacy attribution plan contains an invalid or duplicate order.");
    }
    seen.add(orderNumber);
    const eventCount = Number(attribution.eventCount);
    const lastEventAt = toIso(attribution.lastEventAt);
    if (!Number.isSafeInteger(eventCount) || eventCount < 0 || !lastEventAt) {
      throw new Error("Legacy attribution plan is missing its source checkpoint.");
    }
    return {
      decisionSource: attribution.decisionSource === "manual" ? "manual" : "automatic",
      evidenceStatus: attribution.decisionSource === "manual"
        ? String(attribution.evidenceStatus || "recipient_unknown")
        : "mailbox_match",
      eventCount,
      lastEventAt,
      orderNumber,
      targetShopCode,
      targetOrderExisted: attribution.targetOrderExisted === true,
    };
  });
}

async function inspectLegacyApplyTargets(attributions) {
  if (!Array.isArray(attributions) || !attributions.length) return [];
  const tables = getTables();
  const planJson = JSON.stringify(attributions.map((attribution) => ({
    order_number: normalizeShopeeOrderNumber(attribution?.orderNumber),
    target_shop_code: normalizeShopeeShopCode(attribution?.targetShopCode),
  })));
  const result = await pool.query(
    `
      WITH plan AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS p(
          order_number text,
          target_shop_code text
        )
      )
      SELECT p.order_number, p.target_shop_code
      FROM plan p
      JOIN ${tables.shopeeOrders} target
        ON target.shop_code = p.target_shop_code
       AND target.order_number = p.order_number
      ORDER BY p.order_number
    `,
    [planJson],
  );
  return result.rows.map((row) => ({
    orderNumber: normalizeShopeeOrderNumber(row.order_number),
    targetShopCode: normalizeShopeeShopCode(row.target_shop_code),
  }));
}

async function applyLegacyAttributions({ attributions, planDigest }) {
  const normalized = normalizeApplyAttributions(attributions);
  const digest = String(planDigest || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error("A valid apply plan digest is required.");

  const tables = getTables();
  const planJson = JSON.stringify(normalized.map((attribution) => ({
    decision_source: attribution.decisionSource,
    evidence_status: attribution.evidenceStatus,
    event_count: attribution.eventCount,
    expected_target_existed: attribution.targetOrderExisted,
    last_event_at: attribution.lastEventAt,
    order_number: attribution.orderNumber,
    target_shop_code: attribution.targetShopCode,
  })));
  const planCte = `
    WITH plan AS (
      SELECT *
      FROM jsonb_to_recordset($1::jsonb) AS p(
        order_number text,
        target_shop_code text,
        evidence_status text,
        decision_source text,
        event_count integer,
        expected_target_existed boolean,
        last_event_at timestamptz
      )
    )
  `;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lockResult = await client.query(
      "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired",
      ["shopee-legacy-reconciliation-apply"],
    );
    if (lockResult.rows[0]?.acquired !== true) {
      throw conflict("A legacy Shopee timeline apply is already running.");
    }

    const lockedLegacy = await client.query(
      `${planCte}
       SELECT o.order_number
       FROM plan p
       JOIN ${tables.shopeeOrders} o
         ON o.shop_code = $2
        AND o.order_number = p.order_number
        AND o.last_event_at = p.last_event_at
       ORDER BY o.order_number
       FOR UPDATE OF o`,
      [planJson, LEGACY_SHOP_CODE],
    );
    if (lockedLegacy.rows.length !== normalized.length) {
      throw conflict("Legacy attribution plan is stale; run a new dry-run before applying.");
    }

    await client.query(
      `${planCte}
       SELECT target.order_number
       FROM plan p
       JOIN ${tables.shopeeOrders} target
         ON target.shop_code = p.target_shop_code
        AND target.order_number = p.order_number
       ORDER BY target.shop_code, target.order_number
       FOR UPDATE OF target`,
      [planJson],
    );

    const eventCountResult = await client.query(
      `${planCte}
       SELECT COUNT(*) AS count
       FROM ${tables.shopeeOrderEvents} e
       JOIN plan p ON p.order_number = e.order_number
       WHERE e.shop_code = $2`,
      [planJson, LEGACY_SHOP_CODE],
    );
    const eventCount = Number(eventCountResult.rows[0]?.count || 0);
    const expectedEventCount = normalized.reduce((sum, attribution) => (
      sum + attribution.eventCount
    ), 0);
    if (eventCount !== expectedEventCount) {
      throw conflict("Legacy event checkpoint changed; run a new dry-run before applying.");
    }
    const batchResult = await client.query(
      `INSERT INTO ${tables.shopeeLegacyReconciliationApplyBatches}
        (plan_digest, order_count, event_count)
       VALUES ($1, $2, $3)
       RETURNING id, created_at`,
      [digest, normalized.length, eventCount],
    );
    const batch = batchResult.rows[0];

    const auditResult = await client.query(
      `${planCte}
       INSERT INTO ${tables.shopeeLegacyReconciliationApplyItems} (
         batch_id,
         order_number,
         target_shop_code,
         target_order_existed,
         legacy_order_snapshot,
         target_order_snapshot,
         moved_event_ids
       )
       SELECT
         $2::uuid,
         legacy.order_number,
         p.target_shop_code,
         target.order_number IS NOT NULL,
         to_jsonb(legacy),
         CASE WHEN target.order_number IS NULL THEN NULL ELSE to_jsonb(target) END,
         ARRAY(
           SELECT e.id
           FROM ${tables.shopeeOrderEvents} e
           WHERE e.shop_code = $3 AND e.order_number = legacy.order_number
           ORDER BY e.occurred_at, e.id
         )
       FROM plan p
       JOIN ${tables.shopeeOrders} legacy
         ON legacy.shop_code = $3 AND legacy.order_number = p.order_number
       LEFT JOIN ${tables.shopeeOrders} target
         ON target.shop_code = p.target_shop_code
        AND target.order_number = p.order_number
       RETURNING order_number, target_order_existed`,
      [planJson, batch.id, LEGACY_SHOP_CODE],
    );
    const expectedTargetState = new Map(normalized.map((attribution) => (
      [attribution.orderNumber, attribution.targetOrderExisted]
    )));
    const targetStateChanged = auditResult.rows.some((row) => (
      row.target_order_existed !== expectedTargetState.get(row.order_number)
    ));
    if (auditResult.rows.length !== normalized.length || targetStateChanged) {
      throw conflict("Timeline collision state changed; run a new dry-run before applying.");
    }

    await client.query(
      `${planCte}
       INSERT INTO ${tables.shopeeOrders} AS existing_order (
         shop_code,
         order_number,
         current_status,
         ordered_at,
         shipping_deadline,
         items,
         item_count,
         total_quantity,
         item_subtotal,
         shipping_fee,
         total_amount,
         delivery_method,
         first_event_at,
         last_event_at,
         created_at,
         updated_at
       )
       SELECT
         p.target_shop_code,
         legacy.order_number,
         legacy.current_status,
         legacy.ordered_at,
         legacy.shipping_deadline,
         legacy.items,
         legacy.item_count,
         legacy.total_quantity,
         legacy.item_subtotal,
         legacy.shipping_fee,
         legacy.total_amount,
         legacy.delivery_method,
         legacy.first_event_at,
         legacy.last_event_at,
         legacy.created_at,
         legacy.updated_at
       FROM plan p
       JOIN ${tables.shopeeOrders} legacy
         ON legacy.shop_code = $2 AND legacy.order_number = p.order_number
       ON CONFLICT (shop_code, order_number) DO UPDATE SET
         current_status = CASE
           WHEN EXCLUDED.last_event_at >= existing_order.last_event_at
             THEN EXCLUDED.current_status
           ELSE existing_order.current_status
         END,
         ordered_at = COALESCE(existing_order.ordered_at, EXCLUDED.ordered_at),
         shipping_deadline = COALESCE(EXCLUDED.shipping_deadline, existing_order.shipping_deadline),
         items = CASE
           WHEN jsonb_array_length(EXCLUDED.items) > 0 THEN EXCLUDED.items
           ELSE existing_order.items
         END,
         item_count = GREATEST(existing_order.item_count, EXCLUDED.item_count),
         total_quantity = GREATEST(existing_order.total_quantity, EXCLUDED.total_quantity),
         item_subtotal = COALESCE(EXCLUDED.item_subtotal, existing_order.item_subtotal),
         shipping_fee = COALESCE(EXCLUDED.shipping_fee, existing_order.shipping_fee),
         total_amount = COALESCE(EXCLUDED.total_amount, existing_order.total_amount),
         delivery_method = COALESCE(EXCLUDED.delivery_method, existing_order.delivery_method),
         first_event_at = LEAST(existing_order.first_event_at, EXCLUDED.first_event_at),
         last_event_at = GREATEST(existing_order.last_event_at, EXCLUDED.last_event_at)`,
      [planJson, LEGACY_SHOP_CODE],
    );

    const movedEvents = await client.query(
      `${planCte}
       UPDATE ${tables.shopeeOrderEvents} e
       SET shop_code = p.target_shop_code
       FROM plan p
       WHERE e.shop_code = $2 AND e.order_number = p.order_number
       RETURNING e.id`,
      [planJson, LEGACY_SHOP_CODE],
    );
    if (movedEvents.rows.length !== eventCount) {
      throw conflict("Legacy event count changed during apply; transaction was rolled back.");
    }

    await client.query(
      `${planCte}
       INSERT INTO ${tables.shopeeLegacyReconciliationDecisions} AS existing_decision (
         order_number,
         selected_shop_code,
         suggested_shop_code,
         evidence_status,
         decision_source,
         decision_status,
         reviewed_at,
         applied_at
       )
       SELECT
         p.order_number,
         p.target_shop_code,
         p.target_shop_code,
         p.evidence_status,
         p.decision_source,
         'applied',
         now(),
         now()
       FROM plan p
       ON CONFLICT (order_number) DO UPDATE SET
         selected_shop_code = EXCLUDED.selected_shop_code,
         suggested_shop_code = EXCLUDED.suggested_shop_code,
         evidence_status = EXCLUDED.evidence_status,
         decision_source = EXCLUDED.decision_source,
         decision_status = 'applied',
         reviewed_at = COALESCE(existing_decision.reviewed_at, EXCLUDED.reviewed_at),
         applied_at = EXCLUDED.applied_at`,
      [planJson],
    );

    const deletedOrders = await client.query(
      `${planCte}
       DELETE FROM ${tables.shopeeOrders} legacy
       USING plan p
       WHERE legacy.shop_code = $2 AND legacy.order_number = p.order_number
       RETURNING legacy.order_number`,
      [planJson, LEGACY_SHOP_CODE],
    );
    if (deletedOrders.rows.length !== normalized.length) {
      throw conflict("Legacy order count changed during apply; transaction was rolled back.");
    }

    await client.query("COMMIT");
    const mergedOrderCount = auditResult.rows.filter((row) => row.target_order_existed).length;
    return {
      appliedAt: batch.created_at instanceof Date
        ? batch.created_at.toISOString()
        : String(batch.created_at),
      batchId: batch.id,
      createdOrderCount: normalized.length - mergedOrderCount,
      eventCount,
      mergedOrderCount,
      orderCount: normalized.length,
      planDigest: digest,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  LEGACY_SHOP_CODE,
  applyLegacyAttributions,
  getLegacyOrder,
  inspectLegacyApplyTargets,
  listLegacyOrders,
  mapLegacyRow,
  saveDecision,
};
