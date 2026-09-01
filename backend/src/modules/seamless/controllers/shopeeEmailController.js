const { badRequest } = require("../errors");
const {
  CATEGORY_QUERIES,
  listShopeeEmailInbox,
} = require("../services/shopeeEmailInboxService");
const {
  SHOPEE_ALL_SHOPS_SCOPE,
  requireShopeeShopScope,
} = require("../services/shopeeShops");

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseCalendarDate(value, name) {
  if (value === undefined || value === "") return undefined;
  if (!DATE_ONLY_PATTERN.test(value)) {
    throw badRequest(`${name} must be a calendar date in YYYY-MM-DD format.`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    throw badRequest(`${name} must be a valid calendar date.`);
  }
  return value;
}

function toIctMidnightIso(dateStr) {
  return new Date(`${dateStr}T00:00:00+07:00`).toISOString();
}

function toNextIctMidnightIso(dateStr) {
  const end = new Date(`${dateStr}T00:00:00+07:00`);
  end.setUTCHours(end.getUTCHours() + 24);
  return end.toISOString();
}

function parseLimit(value) {
  if (value === undefined || value === "") return 25;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 25) {
    throw badRequest("limit must be an integer from 1 to 25.");
  }
  return parsed;
}

const PUBLIC_SHOPEE_SUBJECTS = Object.freeze({
  order_cancelled: "คำสั่งซื้อถูกยกเลิก",
  order_confirmed: "คำสั่งซื้อถูกยืนยันแล้ว",
  out_of_stock: "สินค้า Shopee ขายหมดแล้ว",
  security_alert: "แจ้งเตือนความปลอดภัยของบัญชี Shopee",
  seller_return_delivery: "พัสดุกำลังจัดส่งคืนผู้ขาย",
  shipment_due: "ถึงเวลาจัดส่งสินค้า",
});

function buildPublicShopeeSubject(email) {
  const orderNumber = String(
    email?.orderNumber || String(email?.subject || "").match(/#([A-Z0-9]+)/iu)?.[1] || "",
  ).trim();
  const label = PUBLIC_SHOPEE_SUBJECTS[email?.category] || "การแจ้งเตือนจาก Shopee";
  return orderNumber ? `${label} #${orderNumber}` : label;
}

function sanitizeShopeeEmailForRole(email, role) {
  // Buyer identifiers are not required by any role. Apply the same public contract to admins so
  // credentials or role changes cannot turn this endpoint into a PII disclosure path. Rebuild
  // the subject from bounded category/order fields rather than trying to enumerate every future
  // Shopee buyer-identifier phrase.
  void role;
  return { ...email, subject: buildPublicShopeeSubject(email) };
}

async function listInbox(req, res) {
  const { category, cursor, limit, receivedFrom, receivedTo, shopCode } = req.query || {};
  if (category && !Object.prototype.hasOwnProperty.call(CATEGORY_QUERIES, category)) {
    throw badRequest(`Invalid category filter. Expected one of: ${Object.keys(CATEGORY_QUERIES).join(", ")}`);
  }
  if (cursor && String(cursor).length > 2048) {
    throw badRequest("cursor is too long.");
  }

  const fromDate = parseCalendarDate(receivedFrom, "receivedFrom");
  const toDate = parseCalendarDate(receivedTo, "receivedTo");
  if (fromDate && toDate && fromDate > toDate) {
    throw badRequest("receivedFrom must be on or before receivedTo.");
  }

  const result = await listShopeeEmailInbox({
    category: category || undefined,
    cursor: cursor || undefined,
    limit: parseLimit(limit),
    receivedFrom: fromDate ? toIctMidnightIso(fromDate) : undefined,
    receivedTo: toDate ? toNextIctMidnightIso(toDate) : undefined,
    shopCode: requireShopeeShopScope(shopCode || SHOPEE_ALL_SHOPS_SCOPE),
  });
  res.json({
    ...result,
    emails: result.emails.map((email) => sanitizeShopeeEmailForRole(email, req.appRole)),
  });
}

module.exports = {
  buildPublicShopeeSubject,
  listInbox,
  sanitizeShopeeEmailForRole,
};
