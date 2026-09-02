const pool = require("../../../../db");
const { conflict, notFound } = require("../errors");
const {
  normalizeShopeeOrderNumber,
  sanitizeShopeeOrderEventDetails,
  sanitizeShopeeOrderItems,
} = require("../shopeeOrderValidation");
const {
  SHOPEE_ALL_SHOPS_SCOPE,
  SHOPEE_SHOP_PROFILES,
  normalizeShopeeShopCode,
} = require("../services/shopeeShops");
const {
  enrichShopeeOrderItems,
  summarizeShopeeProductMatches,
} = require("../services/shopeeProductMatcher");
const { getTables } = require("../tables");

const SHOPEE_ORDER_SYNC_LOCK_PREFIX = "shopee-order-timeline-sync";
const CANONICAL_MESSAGE_KEY_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SHOPEE_ORDER_STATUS_SEARCH_LABELS = Object.freeze({
  order_confirmed: "ยืนยันคำสั่งซื้อ COD",
  shipment_due: "ถึงเวลาจัดส่ง",
  seller_return_delivery: "พัสดุส่งคืนผู้ขาย",
  order_cancelled: "ยกเลิกคำสั่งซื้อ",
});
const SEARCH_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("th-TH", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Bangkok",
});
const SEARCH_DATE_FORMATTER = new Intl.DateTimeFormat("th-TH", {
  dateStyle: "medium",
  timeZone: "Asia/Bangkok",
});
const SEARCH_MONEY_FORMATTER = new Intl.NumberFormat("th-TH", {
  style: "currency",
  currency: "THB",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

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

function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("th-TH")
    .replace(/\s+/gu, " ")
    .trim();
}

function formatSearchDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : SEARCH_DATE_TIME_FORMATTER.format(date);
}

function formatSearchDate(value) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00+07:00`);
  return Number.isNaN(date.getTime()) ? String(value) : SEARCH_DATE_FORMATTER.format(date);
}

function formatProductMatchSearchText(productMatch) {
  if (productMatch?.status === "matched") {
    return productMatch.companySku || "";
  }
  if (productMatch?.status === "bundle") {
    const components = (productMatch.components || []).map((component) => (
      component.quantityPerSale
        ? `${component.companySku} ×${component.quantityPerSale}`
        : component.companySku
    ));
    return `${components.join(" + ")} ชุดหลาย SKU`;
  }
  if (productMatch?.status === "visibility_only") return "สินค้าเพิ่มการมองเห็น";
  if (productMatch?.status === "unmapped") return "รอตรวจสอบ SKU";
  return "";
}

function buildShopeeOrderSearchText(order) {
  const shopProfile = SHOPEE_SHOP_PROFILES[order?.shopCode];
  const values = [
    shopProfile?.displayName,
    order?.shopCode,
    order?.orderNumber,
    order?.currentStatus,
    SHOPEE_ORDER_STATUS_SEARCH_LABELS[order?.currentStatus],
    order?.itemCount,
    order?.itemCount > 1 ? `+${order.itemCount - 1}` : "",
    order?.totalQuantity,
    order?.totalAmount,
    order?.totalAmount === null || order?.totalAmount === undefined
      ? ""
      : SEARCH_MONEY_FORMATTER.format(order.totalAmount),
    order?.shippingDeadline,
    formatSearchDate(order?.shippingDeadline),
    order?.lastEventAt,
    formatSearchDateTime(order?.lastEventAt),
    order?.eventCount,
    `ดู ${order?.eventCount || 0}`,
    `เหตุการณ์ ${order?.eventCount || 0}`,
  ];

  (order?.items || []).forEach((item) => {
    values.push(
      item?.name,
      item?.variant,
      item?.quantity,
      item?.unitPrice,
      item?.unitPrice === null || item?.unitPrice === undefined
        ? ""
        : SEARCH_MONEY_FORMATTER.format(item.unitPrice),
      formatProductMatchSearchText(item?.productMatch),
    );
  });

  return normalizeSearchText(values.filter((value) => value !== null && value !== undefined).join(" "));
}

function matchesShopeeOrderSearch(order, search) {
  const terms = normalizeSearchText(search).split(" ").filter(Boolean);
  if (!terms.length) return true;
  const haystack = buildShopeeOrderSearchText(order);
  return terms.every((term) => haystack.includes(term));
}

function compareShopeeOrders(left, right, sortBy, sortOrder) {
  const fields = sortBy === "orderNumber"
    ? ["orderNumber", "shopCode", "lastEventAt"]
    : ["lastEventAt", "shopCode", "orderNumber"];
  const multiplier = sortOrder === "asc" ? 1 : -1;

  for (const field of fields) {
    const leftValue = String(left?.[field] || "");
    const rightValue = String(right?.[field] || "");
    if (leftValue < rightValue) return -1 * multiplier;
    if (leftValue > rightValue) return 1 * multiplier;
  }
  return 0;
}

function mapOrder(row) {
  if (!row) return null;
  const shopCode = normalizeShopeeShopCode(row.shop_code);
  const items = enrichShopeeOrderItems(shopCode, sanitizeShopeeOrderItems(row.items));
  return {
    currentStatus: row.current_status,
    deliveryMethod: row.delivery_method || "",
    eventCount: Number(row.event_count || 0),
    firstEventAt: toIso(row.first_event_at),
    itemCount: Number(row.item_count || 0),
    itemSubtotal: toNumber(row.item_subtotal),
    items,
    lastEventAt: toIso(row.last_event_at),
    orderedAt: toIso(row.ordered_at),
    orderNumber: normalizeShopeeOrderNumber(row.order_number),
    shippingDeadline: toDateOnly(row.shipping_deadline),
    shippingFee: toNumber(row.shipping_fee),
    productMapping: summarizeShopeeProductMatches(items),
    shopCode,
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
    shopCode: normalizeShopeeShopCode(row.shop_code),
  };
}

function requirePersistenceShopCode(value) {
  const shopCode = normalizeShopeeShopCode(value);
  if (!shopCode) throw new Error("A supported shopCode is required for Shopee order persistence.");
  return shopCode;
}

function requireListShopScope(value) {
  if (value === SHOPEE_ALL_SHOPS_SCOPE) return SHOPEE_ALL_SHOPS_SCOPE;
  return requirePersistenceShopCode(value);
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

async function withShopeeOrderSyncLock(shopCodeValue, mailboxAccount, callback) {
  const shopCode = requirePersistenceShopCode(shopCodeValue);
  const mailbox = String(mailboxAccount || "").trim().toLowerCase();
  if (!mailbox) throw new Error("mailboxAccount is required for Shopee order sync locking.");
  if (typeof callback !== "function") throw new TypeError("Shopee order sync callback is required.");

  const client = await pool.connect();
  const lockName = `${SHOPEE_ORDER_SYNC_LOCK_PREFIX}:${shopCode}:${mailbox}`;
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
  const shopCode = requirePersistenceShopCode(parsed?.order?.shopCode);
  const eventShopCode = requirePersistenceShopCode(parsed?.event?.shopCode);
  const orderNumber = normalizeShopeeOrderNumber(parsed?.order?.orderNumber);
  const eventOrderNumber = normalizeShopeeOrderNumber(parsed?.event?.orderNumber);
  if (!orderNumber || eventOrderNumber !== orderNumber || eventShopCode !== shopCode) {
    throw new Error("Shopee order and event must use the same valid shop and order number.");
  }
  const canonicalMessageKey = String(parsed?.event?.canonicalMessageKey || "").trim();
  if (!CANONICAL_MESSAGE_KEY_PATTERN.test(canonicalMessageKey)) {
    throw new Error("A valid canonicalMessageKey is required for Shopee event persistence.");
  }
  const mailboxAccount = String(parsed?.event?.mailboxAccount || "").trim().toLowerCase();
  const gmailMessageId = String(parsed?.event?.gmailMessageId || "").trim();
  if (!mailboxAccount || !gmailMessageId) {
    throw new Error("Shopee events require mailboxAccount and gmailMessageId.");
  }

  const sanitizedItems = sanitizeShopeeOrderItems(parsed.order.items);
  return runTransaction(async (client) => {
    const tables = getTables();
    const order = parsed.order;
    const event = parsed.event;
    // Serialize by the privacy-safe canonical key so two mailboxes cannot both pass the
    // existence check and create/update different shop orders for the same forwarded email.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [canonicalMessageKey]);
    const duplicateResult = await client.query(
      `
        SELECT shop_code, order_number
        FROM ${tables.shopeeOrderEvents}
        WHERE canonical_message_key = $1
           OR (mailbox_account = $2 AND gmail_message_id = $3)
        LIMIT 1
        FOR UPDATE
      `,
      [canonicalMessageKey, mailboxAccount, gmailMessageId],
    );
    if (duplicateResult.rows.length) {
      return {
        duplicateShopCode: normalizeShopeeShopCode(duplicateResult.rows[0].shop_code) || null,
        eventCreated: false,
        order: null,
      };
    }

    const orderResult = await client.query(
      `
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
          last_event_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14)
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
          last_event_at = GREATEST(existing_order.last_event_at, EXCLUDED.last_event_at)
        RETURNING *
      `,
      [
        shopCode,
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
          shop_code,
          order_number,
          canonical_message_key,
          mailbox_account,
          gmail_message_id,
          gmail_thread_id,
          event_type,
          occurred_at,
          details
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        ON CONFLICT DO NOTHING
        RETURNING *
      `,
      [
        eventShopCode,
        eventOrderNumber,
        canonicalMessageKey,
        mailboxAccount,
        gmailMessageId,
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

async function listOrders({
  cursor = null,
  limit = 25,
  page = null,
  search = null,
  shopCode: shopCodeValue,
  sortBy = "lastEventAt",
  sortOrder = "desc",
  status = null,
} = {}) {
  const shopCode = requireListShopScope(shopCodeValue);
  const tables = getTables();
  const isAllShops = shopCode === SHOPEE_ALL_SHOPS_SCOPE;
  const isNumberedPage = Number.isInteger(page);
  const direction = sortOrder === "asc" ? "ASC" : "DESC";
  const orderBy = sortBy === "orderNumber"
    ? `o.order_number ${direction}, o.shop_code ${direction}, o.last_event_at ${direction}`
    : `o.last_event_at ${direction}, o.shop_code ${direction}, o.order_number ${direction}`;
  const params = [isAllShops ? Object.keys(SHOPEE_SHOP_PROFILES) : shopCode];
  const where = [isAllShops ? "o.shop_code = ANY($1::text[])" : "o.shop_code = $1"];
  if (status) {
    params.push(status);
    where.push(`o.current_status = $${params.length}`);
  }
  if (cursor) {
    params.push(cursor.lastEventAt, cursor.rowShopCode || shopCode, cursor.orderNumber);
    where.push(
      `(o.last_event_at, o.shop_code, o.order_number) < `
      + `($${params.length - 2}, $${params.length - 1}, $${params.length})`,
    );
  }

  if (search) {
    const searchResult = await pool.query(
      `
        SELECT
          o.*,
          (SELECT COUNT(*) FROM ${tables.shopeeOrderEvents} e
            WHERE e.shop_code = o.shop_code AND e.order_number = o.order_number) AS event_count
        FROM ${tables.shopeeOrders} o
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      `,
      params,
    );
    const matchingOrders = searchResult.rows
      .map(mapOrder)
      .filter((order) => matchesShopeeOrderSearch(order, search))
      .sort((left, right) => compareShopeeOrders(left, right, sortBy, sortOrder));
    const offset = isNumberedPage ? (page - 1) * limit : 0;
    return {
      hasMore: offset + limit < matchingOrders.length,
      orders: matchingOrders.slice(offset, offset + limit),
      totalCount: isNumberedPage ? matchingOrders.length : null,
    };
  }

  params.push(isNumberedPage ? limit : limit + 1);
  const limitParameter = params.length;
  if (isNumberedPage) params.push((page - 1) * limit);

  const result = await pool.query(
    isNumberedPage
      ? `
        WITH total AS (
          SELECT COUNT(*) AS total_count
          FROM ${tables.shopeeOrders} o
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ), page_rows AS (
          SELECT
            o.*,
            (SELECT COUNT(*) FROM ${tables.shopeeOrderEvents} e
              WHERE e.shop_code = o.shop_code AND e.order_number = o.order_number) AS event_count
          FROM ${tables.shopeeOrders} o
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY ${orderBy}
          LIMIT $${limitParameter}
          OFFSET $${params.length}
        )
        SELECT page_rows.*, total.total_count
        FROM total
        LEFT JOIN page_rows ON TRUE
      `
      : `
        SELECT
          o.*,
          (SELECT COUNT(*) FROM ${tables.shopeeOrderEvents} e
            WHERE e.shop_code = o.shop_code AND e.order_number = o.order_number) AS event_count
        FROM ${tables.shopeeOrders} o
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY ${orderBy}
        LIMIT $${limitParameter}
      `,
    params,
  );

  const totalCount = isNumberedPage ? Number(result.rows[0]?.total_count || 0) : null;
  const hasMore = isNumberedPage
    ? page * limit < totalCount
    : result.rows.length > limit;
  const pageRows = isNumberedPage
    ? result.rows.filter((row) => row.order_number)
    : result.rows;
  const rows = !isNumberedPage && hasMore ? pageRows.slice(0, limit) : pageRows;
  return { hasMore, orders: rows.map(mapOrder), totalCount };
}

async function listOrdersForSalesSummary({
  endDate,
  shopCode: shopCodeValue,
  startDate,
} = {}) {
  const shopCode = requireListShopScope(shopCodeValue);
  const tables = getTables();
  const isAllShops = shopCode === SHOPEE_ALL_SHOPS_SCOPE;
  const shopScope = isAllShops ? Object.keys(SHOPEE_SHOP_PROFILES) : shopCode;

  const result = await pool.query(
    `
      SELECT o.*, 0::bigint AS event_count
      FROM ${tables.shopeeOrders} o
      WHERE ${isAllShops ? "o.shop_code = ANY($1::text[])" : "o.shop_code = $1"}
        AND o.ordered_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Bangkok')
        AND o.ordered_at < (($3::date::timestamp + INTERVAL '1 day') AT TIME ZONE 'Asia/Bangkok')
        AND o.current_status IN ('order_confirmed', 'shipment_due')
        AND jsonb_array_length(o.items) > 0
      ORDER BY o.ordered_at DESC, o.shop_code ASC, o.order_number ASC
    `,
    [shopScope, startDate, endDate],
  );

  return result.rows.map(mapOrder);
}

async function getOrderTimeline(shopCodeValue, orderNumber) {
  const shopCode = requirePersistenceShopCode(shopCodeValue);
  const tables = getTables();
  const [orderResult, eventsResult] = await Promise.all([
    pool.query(
      `
        SELECT
          o.*,
          (SELECT COUNT(*) FROM ${tables.shopeeOrderEvents} e
            WHERE e.shop_code = o.shop_code AND e.order_number = o.order_number) AS event_count
        FROM ${tables.shopeeOrders} o
        WHERE o.shop_code = $1 AND o.order_number = $2
      `,
      [shopCode, orderNumber],
    ),
    pool.query(
      `
        SELECT id, shop_code, event_type, occurred_at, details
        FROM ${tables.shopeeOrderEvents}
        WHERE shop_code = $1 AND order_number = $2
        ORDER BY occurred_at ASC, id ASC
      `,
      [shopCode, orderNumber],
    ),
  ]);

  if (!orderResult.rows.length) {
    throw notFound(`Shopee order not found for ${shopCode}: ${orderNumber}`);
  }
  return {
    events: eventsResult.rows.map(mapEvent),
    order: mapOrder(orderResult.rows[0]),
  };
}

async function findOrdersForAdaSmartValidation(shopCodeValue, orderNumbers) {
  const shopCode = requirePersistenceShopCode(shopCodeValue);
  const normalizedOrderNumbers = [...new Set((Array.isArray(orderNumbers) ? orderNumbers : [])
    .map(normalizeShopeeOrderNumber)
    .filter(Boolean))]
    .sort();
  if (!normalizedOrderNumbers.length) return [];

  const tables = getTables();
  const result = await pool.query(
    `
      SELECT
        o.*,
        (SELECT COUNT(*) FROM ${tables.shopeeOrderEvents} e
          WHERE e.shop_code = o.shop_code AND e.order_number = o.order_number) AS event_count
      FROM ${tables.shopeeOrders} o
      WHERE o.shop_code = $1
        AND o.order_number = ANY($2::text[])
      ORDER BY o.order_number ASC
    `,
    [shopCode, normalizedOrderNumbers],
  );

  return result.rows.map(mapOrder);
}

module.exports = {
  buildShopeeOrderSearchText,
  findOrdersForAdaSmartValidation,
  getOrderTimeline,
  listOrders,
  listOrdersForSalesSummary,
  mapEvent,
  mapOrder,
  matchesShopeeOrderSearch,
  upsertOrderEvent,
  withShopeeOrderSyncLock,
};
