const repository = require("../db/shopeeOrderRepository");
const financialVisibilityRepository = require("../db/shopeeFinancialVisibilityRepository");
const { badRequest, forbidden } = require("../errors");
const {
  normalizeShopeeOrderNumber,
  SHOPEE_ORDER_NUMBER_PATTERN,
} = require("../shopeeOrderValidation");
const { TIMELINE_EVENT_TYPES } = require("../services/shopeeOrderEmailParser");
const { syncShopeeOrderPage } = require("../services/shopeeOrderTimelineService");
const { getShopeeSalesSummary } = require("../services/shopeeSalesSummaryService");
const {
  getViewerFinancialVisibility,
  normalizeUserFinancialVisibility,
  sanitizeShopeeOrderFinancials,
} = require("../services/shopeeFinancialVisibilityService");
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

function parseSearch(value) {
  if (value === undefined || value === "") return null;
  const normalized = String(value)
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return null;
  if (normalized.length > 120) {
    throw badRequest("search must not exceed 120 characters.");
  }
  return normalized;
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
  const search = parseSearch(req.query?.search);
  const sortBy = parseSortBy(req.query?.sortBy);
  const sortOrder = parseSortOrder(req.query?.sortOrder);
  if (req.query?.cursor && page) {
    throw badRequest("cursor and page cannot be used together.");
  }
  if (req.query?.cursor && search) {
    throw badRequest("cursor and search cannot be used together; use numbered pages.");
  }
  if (req.query?.cursor && (sortBy !== "lastEventAt" || sortOrder !== "desc")) {
    throw badRequest("cursor pagination supports only lastEventAt descending sort.");
  }
  const userFinancialVisibility = await financialVisibilityRepository
    .getUserFinancialVisibility();
  const financialVisibility = getViewerFinancialVisibility(
    req.appRole,
    userFinancialVisibility,
  );
  const result = await repository.listOrders({
    cursor: parseOpaqueCursor(req.query?.cursor, shopCode),
    financialVisibility,
    limit,
    page,
    search,
    shopCode,
    sortBy,
    sortOrder,
    status: parseStatus(req.query?.status),
  });
  const lastOrder = result.orders[result.orders.length - 1];
  res.json({
    nextCursor: !page && result.hasMore && lastOrder ? encodeCursor(lastOrder, shopCode) : null,
    financialVisibility,
    orders: result.orders.map((order) => (
      sanitizeShopeeOrderFinancials(order, financialVisibility)
    )),
    ...(page ? {
      page,
      pageSize: limit,
      totalCount: result.totalCount,
      totalPages: Math.ceil(result.totalCount / limit),
    } : {}),
    shopCode,
    search: search || "",
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

async function getInboxOverview(req, res) {
  const shopCode = requireShopeeShopScope(req.query?.shopCode || SHOPEE_ALL_SHOPS_SCOPE);
  const date = parseDateOnly(req.query?.date, "date");
  res.json({
    ...await repository.getInboxOperationsOverview({ date, shopCode }),
    date,
    shopCode,
    source: "shopee_order_timeline",
    timezone: "Asia/Bangkok",
  });
}

async function getOrder(req, res) {
  const shopCode = requireShopeeShopCode(req.query?.shopCode);
  const [timeline, userFinancialVisibility] = await Promise.all([
    repository.getOrderTimeline(
      shopCode,
      parseOrderNumber(req.params.orderNumber),
    ),
    financialVisibilityRepository.getUserFinancialVisibility(),
  ]);
  const financialVisibility = getViewerFinancialVisibility(
    req.appRole,
    userFinancialVisibility,
  );
  res.json({
    ...timeline,
    financialVisibility,
    order: sanitizeShopeeOrderFinancials(timeline.order, financialVisibility),
  });
}

const HUMAN_ADMIN_AUTH_SOURCES = new Set(["session", "admin_basic", "local_default_open"]);
const MUTABLE_FINANCIAL_VISIBILITY_FIELDS = ["shippingFee", "totalAmount", "unitPrice"];

function requireFinancialVisibilityAdmin(req) {
  if (req.appRole !== "admin" || !HUMAN_ADMIN_AUTH_SOURCES.has(req.appAuthSource)) {
    throw forbidden("Only admin sessions can manage Shopee financial visibility.");
  }
}

function parseFinancialVisibilitySettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("Financial visibility settings are required.");
  }
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !MUTABLE_FINANCIAL_VISIBILITY_FIELDS.includes(key));
  if (unknown.length) {
    throw badRequest(`Unsupported financial visibility setting: ${unknown.join(", ")}.`);
  }
  for (const field of MUTABLE_FINANCIAL_VISIBILITY_FIELDS) {
    if (typeof value[field] !== "boolean") {
      throw badRequest(`${field} must be a boolean.`);
    }
  }
  return normalizeUserFinancialVisibility(value);
}

async function getFinancialVisibility(req, res) {
  requireFinancialVisibilityAdmin(req);
  res.json({
    userFinancialVisibility: await financialVisibilityRepository
      .getUserFinancialVisibility(),
  });
}

async function updateFinancialVisibility(req, res) {
  requireFinancialVisibilityAdmin(req);
  const settings = parseFinancialVisibilitySettings(req.body);
  const updated = await financialVisibilityRepository.updateUserFinancialVisibility(
    settings,
    req.appActor || "admin",
  );
  res.json({ userFinancialVisibility: updated });
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
  getFinancialVisibility,
  getInboxOverview,
  getOrder,
  listSalesSummary,
  listOrders,
  parseOpaqueCursor,
  parsePage,
  parseFinancialVisibilitySettings,
  parseSearch,
  parseSortBy,
  parseSortOrder,
  syncOrders,
  updateFinancialVisibility,
};
