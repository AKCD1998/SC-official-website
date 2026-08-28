const pool = require("../../../../db");
const { notFound } = require("../errors");
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
      evidenceStatus: row.evidence_status,
      reviewedAt: toIso(row.reviewed_at),
      selectedShopCode: normalizeShopeeShopCode(row.selected_shop_code),
      suggestedShopCode: normalizeShopeeShopCode(row.suggested_shop_code) || null,
    } : null,
    eventCount: Number(row.event_count || 0),
    firstEventAt: toIso(row.first_event_at),
    lastEventAt: toIso(row.last_event_at),
    orderNumber: normalizeShopeeOrderNumber(row.order_number),
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
        d.selected_shop_code,
        d.suggested_shop_code,
        d.evidence_status,
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
        d.selected_shop_code,
        d.suggested_shop_code,
        d.evidence_status,
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
        decision_status,
        reviewed_at,
        applied_at
      )
      SELECT o.order_number, $2, $3, $4, 'reviewed', now(), NULL
      FROM ${tables.shopeeOrders} o
      WHERE o.shop_code = $1 AND o.order_number = $5
      ON CONFLICT (order_number) DO UPDATE SET
        selected_shop_code = EXCLUDED.selected_shop_code,
        suggested_shop_code = EXCLUDED.suggested_shop_code,
        evidence_status = EXCLUDED.evidence_status,
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

module.exports = {
  LEGACY_SHOP_CODE,
  getLegacyOrder,
  listLegacyOrders,
  mapLegacyRow,
  saveDecision,
};
