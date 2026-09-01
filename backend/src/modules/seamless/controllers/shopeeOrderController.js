const repository = require("../db/shopeeOrderRepository");
const { badRequest, forbidden } = require("../errors");
const {
  normalizeShopeeOrderNumber,
  SHOPEE_ORDER_NUMBER_PATTERN,
} = require("../shopeeOrderValidation");
const { TIMELINE_EVENT_TYPES } = require("../services/shopeeOrderEmailParser");
const { syncShopeeOrderPage } = require("../services/shopeeOrderTimelineService");
const { getShopeeSalesSummary } = require("../services/shopeeSalesSummaryService");
const {
  SHOPEE_ALL_SHOPS_SCOPE,
  normalizeShopeeShopCode,
  requireShopeeShopCode,
  requireShopeeShopScope,
} = require("../services/shopeeShops");

function parseLimit(value) {
  if (value === undefined || value === "") return 25;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 25) {
    throw badRequest("limit must be an integer from 1 to 25.");
  }
  return parsed;
}

function parsePage(value) {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10000) {
    throw badRequest("page must be an integer from 1 to 10000.");
  }
  return parsed;
}

function parseSortBy(value) {
  if (value === undefined || value === "") return "lastEventAt";
  if (!["lastEventAt", "orderNumber"].includes(value)) {
    throw badRequest("sortBy must be lastEventAt or orderNumber.");
  }
  return value;
}

function parseSortOrder(value) {
  if (value === undefined || value === "") return "desc";
  if (!["asc", "desc"].includes(value)) {
    throw badRequest("sortOrder must be asc or desc.");
  }
  return value;
}

function parseOpaqueCursor(value, expectedShopScope) {
  if (value === undefined || value === "") return null;
  if (String(value).length > 2048) throw badRequest("cursor is too long.");
  try {
    const decoded = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (
      !decoded ||
      decoded.shopCode !== expectedShopScope ||
      Number.isNaN(new Date(decoded.lastEventAt).getTime()) ||
      !SHOPEE_ORDER_NUMBER_PATTERN.test(String(decoded.orderNumber || ""))
    ) {
      throw new Error("invalid cursor payload");
    }
    const rowShopCode = expectedShopScope === SHOPEE_ALL_SHOPS_SCOPE
      ? normalizeShopeeShopCode(decoded.rowShopCode)
      : expectedShopScope;
    if (!rowShopCode) throw new Error("invalid cursor shop");
    return {
      lastEventAt: decoded.lastEventAt,
      orderNumber: decoded.orderNumber,
      rowShopCode,
      shopCode: decoded.shopCode,
    };
  } catch (error) {
    throw badRequest("cursor is invalid.");
  }
}

function encodeCursor(order, shopScope = order.shopCode) {
  const payload = {
    lastEventAt: order.lastEventAt,
    orderNumber: order.orderNumber,
    shopCode: shopScope,
  };
  if (shopScope === SHOPEE_ALL_SHOPS_SCOPE) payload.rowShopCode = order.shopCode;
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function parseStatus(value) {
  if (value === undefined || value === "") return null;
  if (!TIMELINE_EVENT_TYPES.has(value)) {
    throw badRequest(`Invalid status filter. Expected one of: ${[...TIMELINE_EVENT_TYPES].join(", ")}`);
  }
  return value;
}

function parseOrderNumber(value) {
  const orderNumber = normalizeShopeeOrderNumber(value);
  if (!orderNumber) {
    throw badRequest("orderNumber is invalid.");
  }
  return orderNumber;
}

async function listOrders(req, res) {
  const shopCode = requireShopeeShopScope(req.query?.shopCode);
  const limit = parseLimit(req.query?.limit);
  const page = parsePage(req.query?.page);
  const sortBy = parseSortBy(req.query?.sortBy);
  const sortOrder = parseSortOrder(req.query?.sortOrder);
  if (req.query?.cursor && page) {
    throw badRequest("cursor and page cannot be used together.");
  }
  if (req.query?.cursor && (sortBy !== "lastEventAt" || sortOrder !== "desc")) {
    throw badRequest("cursor pagination supports only lastEventAt descending sort.");
  }
  const result = await repository.listOrders({
    cursor: parseOpaqueCursor(req.query?.cursor, shopCode),
    limit,
    page,
    shopCode,
    sortBy,
    sortOrder,
    status: parseStatus(req.query?.status),
  });
  const lastOrder = result.orders[result.orders.length - 1];
  res.json({
    nextCursor: !page && result.hasMore && lastOrder ? encodeCursor(lastOrder, shopCode) : null,
    orders: result.orders,
    ...(page ? {
      page,
      pageSize: limit,
      totalCount: result.totalCount,
      totalPages: Math.ceil(result.totalCount / limit),
    } : {}),
    shopCode,
    sortBy,
    sortOrder,
  });
}

function parseDateOnly(value, label) {
  const normalized = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw badRequest(`${label} must use YYYY-MM-DD format.`);
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw badRequest(`${label} is invalid.`);
  }
  return normalized;
}

async function listSalesSummary(req, res) {
  const shopCode = requireShopeeShopScope(req.query?.shopCode);
  const startDate = parseDateOnly(req.query?.startDate, "startDate");
  const endDate = req.query?.endDate
    ? parseDateOnly(req.query.endDate, "endDate")
    : startDate;
  if (endDate < startDate) {
    throw badRequest("endDate must be on or after startDate.");
  }

  const summary = await getShopeeSalesSummary({ endDate, shopCode, startDate });
  res.json({
    ...summary,
    endDate,
    excludedStatuses: ["order_cancelled", "seller_return_delivery"],
    shopCode,
    startDate,
    timezone: "Asia/Bangkok",
  });
}

async function getOrder(req, res) {
  const shopCode = requireShopeeShopCode(req.query?.shopCode);
  res.json(await repository.getOrderTimeline(
    shopCode,
    parseOrderNumber(req.params.orderNumber),
  ));
}

async function syncOrders(req, res) {
  if (req.appRole !== "admin") {
    throw forbidden("Only admin sessions can sync Shopee order timelines.");
  }
  const cursor = req.body?.cursor;
  if (cursor && String(cursor).length > 2048) throw badRequest("cursor is too long.");
  const shopCode = requireShopeeShopCode(req.body?.shopCode);
  res.json(await syncShopeeOrderPage({
    cursor: cursor || undefined,
    limit: parseLimit(req.body?.limit),
    shopCode,
  }));
}

module.exports = {
  encodeCursor,
  getOrder,
  listSalesSummary,
  listOrders,
  parseOpaqueCursor,
  parsePage,
  parseSortBy,
  parseSortOrder,
  syncOrders,
};
