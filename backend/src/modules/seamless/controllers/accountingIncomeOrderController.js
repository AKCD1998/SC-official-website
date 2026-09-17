const repository = require("../db/accountingIncomeOrderRepository");
const { badRequest } = require("../errors");

const DATE_COLUMNS = new Set(["orderedAt", "transferredAt"]);

function parseInteger(value, label, fallback, maximum) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw badRequest(`${label} must be an integer from 1 to ${maximum}.`);
  }
  return parsed;
}

function parseDateOnly(value, label) {
  if (value === undefined || value === "") return null;
  const normalized = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw badRequest(`${label} must use YYYY-MM-DD format.`);
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw badRequest(`${label} is invalid.`);
  }
  return normalized;
}

function parseIncomeOrderFilters(query = {}) {
  const page = parseInteger(query.page, "page", 1, 10000);
  const pageSize = parseInteger(query.pageSize, "pageSize", 20, 50);
  const dateColumn = query.dateColumn || "transferredAt";
  if (!DATE_COLUMNS.has(dateColumn)) {
    throw badRequest("dateColumn must be orderedAt or transferredAt.");
  }
  const dateFrom = parseDateOnly(query.dateFrom, "dateFrom");
  const dateTo = parseDateOnly(query.dateTo, "dateTo");
  if (dateFrom && dateTo && dateTo < dateFrom) {
    throw badRequest("dateTo must be on or after dateFrom.");
  }
  const orderNumber = String(query.orderNumber || "")
    .normalize("NFKC")
    .trim()
    .toUpperCase();
  if (orderNumber.length > 40 || (orderNumber && !/^[A-Z0-9]+$/u.test(orderNumber))) {
    throw badRequest("orderNumber must contain at most 40 letters or digits.");
  }
  return { dateColumn, dateFrom, dateTo, orderNumber, page, pageSize };
}

async function listIncomeOrders(req, res) {
  const filters = parseIncomeOrderFilters(req.query);
  const result = await repository.listIncomeOrders(filters);
  res.set("Cache-Control", "private, no-store");
  res.json({
    ...result,
    filters: {
      dateColumn: filters.dateColumn,
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      orderNumber: filters.orderNumber,
    },
    page: filters.page,
    pageSize: filters.pageSize,
    timezone: "Asia/Bangkok",
    totalPages: Math.max(1, Math.ceil(result.totalCount / filters.pageSize)),
  });
}

module.exports = { listIncomeOrders, parseIncomeOrderFilters };
