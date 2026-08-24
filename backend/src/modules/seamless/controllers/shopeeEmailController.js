const { badRequest } = require("../errors");
const {
  CATEGORY_QUERIES,
  listShopeeEmailInbox,
} = require("../services/shopeeEmailInboxService");

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

function redactBuyerUsername(subject) {
  return String(subject || "").replace(
    /((?:จากผู้ซื้อ|ถูก(?:ทำการ)?ยกเลิกโดย)\s+)[^\s]+/gu,
    "$1[ปกปิด]",
  );
}

function sanitizeShopeeEmailForRole(email, role) {
  if (role === "admin") return email;
  return { ...email, subject: redactBuyerUsername(email.subject) };
}

async function listInbox(req, res) {
  const { category, cursor, limit, receivedFrom, receivedTo } = req.query || {};
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
  });
  res.json({
    ...result,
    emails: result.emails.map((email) => sanitizeShopeeEmailForRole(email, req.appRole)),
  });
}

module.exports = { listInbox, redactBuyerUsername, sanitizeShopeeEmailForRole };
