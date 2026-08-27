const repository = require("../db/shopeeOrderRepository");
const { badRequest, forbidden } = require("../errors");
const {
  normalizeShopeeOrderNumber,
  SHOPEE_ORDER_NUMBER_PATTERN,
} = require("../shopeeOrderValidation");
const { TIMELINE_EVENT_TYPES } = require("../services/shopeeOrderEmailParser");
const { syncShopeeOrderPage } = require("../services/shopeeOrderTimelineService");
const { requireShopeeShopCode } = require("../services/shopeeShops");

function parseLimit(value) {
  if (value === undefined || value === "") return 25;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 25) {
    throw badRequest("limit must be an integer from 1 to 25.");
  }
  return parsed;
}

function parseOpaqueCursor(value) {
  if (value === undefined || value === "") return null;
  if (String(value).length > 2048) throw badRequest("cursor is too long.");
  try {
    const decoded = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (
      !decoded ||
      Number.isNaN(new Date(decoded.lastEventAt).getTime()) ||
      !SHOPEE_ORDER_NUMBER_PATTERN.test(String(decoded.orderNumber || ""))
    ) {
      throw new Error("invalid cursor payload");
    }
    return { lastEventAt: decoded.lastEventAt, orderNumber: decoded.orderNumber };
  } catch (error) {
    throw badRequest("cursor is invalid.");
  }
}

function encodeCursor(order) {
  return Buffer.from(JSON.stringify({
    lastEventAt: order.lastEventAt,
    orderNumber: order.orderNumber,
  })).toString("base64url");
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
  const limit = parseLimit(req.query?.limit);
  const result = await repository.listOrders({
    cursor: parseOpaqueCursor(req.query?.cursor),
    limit,
    status: parseStatus(req.query?.status),
  });
  const lastOrder = result.orders[result.orders.length - 1];
  res.json({
    nextCursor: result.hasMore && lastOrder ? encodeCursor(lastOrder) : null,
    orders: result.orders,
  });
}

async function getOrder(req, res) {
  res.json(await repository.getOrderTimeline(parseOrderNumber(req.params.orderNumber)));
}

async function syncOrders(req, res) {
  if (req.appRole !== "admin") {
    throw forbidden("Only admin sessions can sync Shopee order timelines.");
  }
  const cursor = req.body?.cursor;
  if (cursor && String(cursor).length > 2048) throw badRequest("cursor is too long.");
  res.json(await syncShopeeOrderPage({
    cursor: cursor || undefined,
    limit: parseLimit(req.body?.limit),
    ...(req.body?.shopCode
      ? { shopCode: requireShopeeShopCode(req.body.shopCode) }
      : {}),
  }));
}

module.exports = {
  encodeCursor,
  getOrder,
  listOrders,
  parseOpaqueCursor,
  syncOrders,
};
