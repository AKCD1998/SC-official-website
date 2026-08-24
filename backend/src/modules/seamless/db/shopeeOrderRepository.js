const pool = require("../../../../db");
const { conflict, notFound } = require("../errors");
const {
  normalizeShopeeOrderNumber,
  sanitizeShopeeOrderEventDetails,
  sanitizeShopeeOrderItems,
} = require("../shopeeOrderValidation");
const { getTables } = require("../tables");

const SHOPEE_ORDER_SYNC_LOCK_PREFIX = "shopee-order-timeline-sync";

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function toDateOnly(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapOrder(row) {
  if (!row) return null;
  return {
    currentStatus: row.current_status,
    deliveryMethod: row.delivery_method || "",
    eventCount: Number(row.event_count || 0),
    firstEventAt: toIso(row.first_event_at),
    itemCount: Number(row.item_count || 0),
    itemSubtotal: toNumber(row.item_subtotal),
    items: sanitizeShopeeOrderItems(row.items),
    lastEventAt: toIso(row.last_event_at),
    orderedAt: toIso(row.ordered_at),
    orderNumber: normalizeShopeeOrderNumber(row.order_number),
    shippingDeadline: toDateOnly(row.shipping_deadline),
    shippingFee: toNumber(row.shipping_fee),
    totalAmount: toNumber(row.total_amount),
    totalQuantity: Number(row.total_quantity || 0),
  };
}

function mapEvent(row) {
  if (!row) return null;
  return {
    details: sanitizeShopeeOrderEventDetails(row.details),
    eventType: row.event_type,
    id: row.id,
    occurredAt: toIso(row.occurred_at),
  };
}

async function runTransaction(callback, providedClient = null) {
  if (providedClient) return callback(providedClient);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function withShopeeOrderSyncLock(mailboxAccount, callback) {
  const mailbox = String(mailboxAccount || "").trim().toLowerCase();
  if (!mailbox) throw new Error("mailboxAccount is required for Shopee order sync locking.");
  if (typeof callback !== "function") throw new TypeError("Shopee order sync callback is required.");

  const client = await pool.connect();
  const lockName = `${SHOPEE_ORDER_SYNC_LOCK_PREFIX}:${mailbox}`;
  let acquired = false;
  let callbackError = null;

  try {
    const lockResult = await client.query(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [lockName],
    );
    acquired = lockResult.rows[0]?.acquired === true;
    if (!acquired) {
      throw conflict("A Shopee order timeline sync is already running for this mailbox.");
    }

    try {
      return await callback();
    } catch (error) {
      callbackError = error;
      throw error;
    }
  } finally {
    let unlockError = null;
    if (acquired) {
      try {
        const unlockResult = await client.query(
          "SELECT pg_advisory_unlock(hashtext($1)) AS unlocked",
          [lockName],
        );
        if (unlockResult.rows[0]?.unlocked !== true) {
          throw new Error("Shopee order sync advisory lock was not released.");
        }
      } catch (error) {
        unlockError = error;
      }
    }

    if (unlockError) client.release(unlockError);
    else client.release();
    if (unlockError && !callbackError) throw unlockError;
  }
}

async function upsertOrderEvent(parsed, providedClient = null) {
  const orderNumber = normalizeShopeeOrderNumber(parsed?.order?.orderNumber);
  const eventOrderNumber = normalizeShopeeOrderNumber(parsed?.event?.orderNumber);
  if (!orderNumber || eventOrderNumber !== orderNumber) {
    throw new Error("Shopee order and event must use the same valid order number.");
  }

  const sanitizedItems = sanitizeShopeeOrderItems(parsed.order.items);
  return runTransaction(async (client) => {
    const tables = getTables();
    const order = parsed.order;
    const event = parsed.event;
    const orderResult = await client.query(
      `
        INSERT INTO ${tables.shopeeOrders} AS existing_order (
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
          last_event_at
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (order_number) DO UPDATE SET
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
          last_event_at = GREATEST(existing_order.last_event_at, EXCLUDED.last_event_at)
        RETURNING *
      `,
      [
        orderNumber,
        order.currentStatus,
        order.orderedAt,
        order.shippingDeadline,
        JSON.stringify(sanitizedItems),
        sanitizedItems.length,
        sanitizedItems.reduce((total, item) => total + item.quantity, 0),
        order.itemSubtotal,
        order.shippingFee,
        order.totalAmount,
        order.deliveryMethod,
        order.firstEventAt,
        order.lastEventAt,
      ],
    );

    const eventResult = await client.query(
      `
        INSERT INTO ${tables.shopeeOrderEvents} (
          order_number,
          mailbox_account,
          gmail_message_id,
          gmail_thread_id,
          event_type,
          occurred_at,
          details
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (mailbox_account, gmail_message_id) DO NOTHING
        RETURNING *
      `,
      [
        eventOrderNumber,
        event.mailboxAccount,
        event.gmailMessageId,
        event.gmailThreadId || null,
        event.eventType,
        event.occurredAt,
        JSON.stringify(sanitizeShopeeOrderEventDetails(event.details)),
      ],
    );

    return {
      eventCreated: eventResult.rows.length > 0,
      order: mapOrder(orderResult.rows[0]),
    };
  }, providedClient);
}

async function listOrders({ cursor = null, limit = 25, status = null } = {}) {
  const tables = getTables();
  const params = [];
  const where = [];
  if (status) {
    params.push(status);
    where.push(`o.current_status = $${params.length}`);
  }
  if (cursor) {
    params.push(cursor.lastEventAt, cursor.orderNumber);
    where.push(`(o.last_event_at, o.order_number) < ($${params.length - 1}, $${params.length})`);
  }
  params.push(limit + 1);

  const result = await pool.query(
    `
      SELECT
        o.*,
        (SELECT COUNT(*) FROM ${tables.shopeeOrderEvents} e WHERE e.order_number = o.order_number) AS event_count
      FROM ${tables.shopeeOrders} o
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY o.last_event_at DESC, o.order_number DESC
      LIMIT $${params.length}
    `,
    params,
  );

  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
  return { hasMore, orders: rows.map(mapOrder) };
}

async function getOrderTimeline(orderNumber) {
  const tables = getTables();
  const [orderResult, eventsResult] = await Promise.all([
    pool.query(
      `
        SELECT
          o.*,
          (SELECT COUNT(*) FROM ${tables.shopeeOrderEvents} e WHERE e.order_number = o.order_number) AS event_count
        FROM ${tables.shopeeOrders} o
        WHERE o.order_number = $1
      `,
      [orderNumber],
    ),
    pool.query(
      `
        SELECT id, event_type, occurred_at, details
        FROM ${tables.shopeeOrderEvents}
        WHERE order_number = $1
        ORDER BY occurred_at ASC, id ASC
      `,
      [orderNumber],
    ),
  ]);

  if (!orderResult.rows.length) {
    throw notFound(`Shopee order not found: ${orderNumber}`);
  }
  return {
    events: eventsResult.rows.map(mapEvent),
    order: mapOrder(orderResult.rows[0]),
  };
}

module.exports = {
  getOrderTimeline,
  listOrders,
  mapEvent,
  mapOrder,
  upsertOrderEvent,
  withShopeeOrderSyncLock,
};
