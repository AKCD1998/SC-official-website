const { badRequest, forbidden } = require("../errors");
const {
  normalizeShopeeOrderNumber,
  SHOPEE_ORDER_NUMBER_PATTERN,
} = require("../shopeeOrderValidation");
const {
  listLegacyReconciliationPage,
  reviewLegacyOrder,
} = require("../services/shopeeLegacyReconciliationService");

const REVIEW_STATUSES = new Set(["all", "pending", "reviewed", "applied"]);

function requireAdmin(req) {
  if (req.appRole !== "admin") throw forbidden("Only admin sessions can review legacy orders.");
}

function parseLimit(value) {
  if (value === undefined || value === "") return 10;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    throw badRequest("limit must be an integer from 1 to 10.");
  }
  return parsed;
}

function parseStatus(value) {
  const status = String(value || "pending").trim().toLowerCase();
  if (!REVIEW_STATUSES.has(status)) throw badRequest("review status is invalid.");
  return status;
}

function parseCursor(value) {
  if (value === undefined || value === "") return null;
  if (String(value).length > 2048) throw badRequest("cursor is too long.");
  try {
    const decoded = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (
      !decoded
      || Number.isNaN(new Date(decoded.lastEventAt).getTime())
      || !SHOPEE_ORDER_NUMBER_PATTERN.test(String(decoded.orderNumber || ""))
    ) throw new Error("invalid cursor");
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

async function listLegacyReviews(req, res) {
  requireAdmin(req);
  const limit = parseLimit(req.query?.limit);
  const result = await listLegacyReconciliationPage({
    cursor: parseCursor(req.query?.cursor),
    limit,
    status: parseStatus(req.query?.status),
  });
  const lastOrder = result.orders[result.orders.length - 1];
  res.json({
    nextCursor: result.hasMore && lastOrder ? encodeCursor(lastOrder) : null,
    orders: result.orders,
    reviewOnly: true,
  });
}

async function saveLegacyReview(req, res) {
  requireAdmin(req);
  const orderNumber = normalizeShopeeOrderNumber(req.params.orderNumber);
  if (!orderNumber) throw badRequest("orderNumber is invalid.");
  res.json(await reviewLegacyOrder({
    orderNumber,
    selectedShopCode: req.body?.shopCode,
  }));
}

module.exports = {
  encodeCursor,
  listLegacyReviews,
  parseCursor,
  saveLegacyReview,
};
