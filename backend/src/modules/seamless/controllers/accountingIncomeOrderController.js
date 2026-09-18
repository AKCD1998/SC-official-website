const repository = require("../db/accountingIncomeOrderRepository");
const exportService = require("../services/accountingIncomeExportService");
const { readPublicBaseUrl } = require("../config");
const { badRequest } = require("../errors");

const DATE_COLUMNS = new Set(["orderedAt", "transferredAt"]);
const SHOP_CODES = new Set(["dr-morepen", "sc-drug-store"]);

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
  const shopCode = String(query.shopCode || "").trim().toLowerCase();
  if (shopCode && !SHOP_CODES.has(shopCode)) {
    throw badRequest("shopCode must be sc-drug-store or dr-morepen.");
  }
  return { dateColumn, dateFrom, dateTo, orderNumber, page, pageSize, shopCode };
}

function parseIncomeExportFilters(query = {}) {
  const filters = parseIncomeOrderFilters({ ...query, page: 1, pageSize: 50 });
  if (filters.dateColumn !== "transferredAt") {
    throw badRequest("Income accounting export must use transferredAt as its dateColumn.");
  }
  if (!filters.dateFrom || !filters.dateTo) {
    throw badRequest("dateFrom and dateTo are required for Income accounting export.");
  }
  const dayCount = Math.round(
    (Date.parse(`${filters.dateTo}T00:00:00.000Z`)
      - Date.parse(`${filters.dateFrom}T00:00:00.000Z`)) / 86400000,
  ) + 1;
  if (dayCount > 366) {
    throw badRequest("Income accounting export cannot cover more than 366 days.");
  }
  return {
    dateColumn: filters.dateColumn,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    orderNumber: filters.orderNumber,
    shopCode: filters.shopCode,
  };
}

function requestPublicOrigin(req) {
  const configuredBaseUrl = readPublicBaseUrl();
  if (configuredBaseUrl) {
    try {
      const configured = new URL(configuredBaseUrl);
      if (configured.protocol === "http:" || configured.protocol === "https:") {
        return configured.origin;
      }
    } catch (error) {
      // Fall back to the current request when the optional public URL is malformed.
    }
  }
  const forwardedProto = String(req.get("x-forwarded-proto") || "").split(",")[0].trim();
  const forwardedHost = String(req.get("x-forwarded-host") || "").split(",")[0].trim();
  const protocol = forwardedProto || req.protocol;
  const host = forwardedHost || req.get("host");
  return host ? `${protocol}://${host}` : "";
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
      shopCode: filters.shopCode,
    },
    page: filters.page,
    pageSize: filters.pageSize,
    timezone: "Asia/Bangkok",
    totalPages: Math.max(1, Math.ceil(result.totalCount / filters.pageSize)),
  });
}

async function exportIncomeOrders(req, res) {
  const filters = parseIncomeExportFilters(req.query);
  const exported = await exportService.exportAccountingIncomeOrders(filters, {
    publicOrigin: requestPublicOrigin(req),
  });
  res.set("Cache-Control", "private, no-store");
  res.setHeader("Content-Type", exported.mimeType);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${exported.filename}"; filename*=UTF-8''${encodeURIComponent(exported.filename)}`,
  );
  res.send(exported.buffer);
}

async function exportIncomeOrdersBundle(req, res) {
  const filters = parseIncomeExportFilters(req.query);
  const exported = await exportService.exportAccountingIncomeOrdersBundle(filters, {
    publicOrigin: requestPublicOrigin(req),
  });
  res.set("Cache-Control", "private, no-store");
  res.setHeader("Content-Type", exported.mimeType);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${exported.filename}"; filename*=UTF-8''${encodeURIComponent(exported.filename)}`,
  );
  res.send(exported.buffer);
}

async function previewIncomeOrdersPdf(req, res) {
  const filters = parseIncomeExportFilters(req.query);
  const exported = await exportService.exportAccountingIncomeOrdersPdf(filters, {
    publicOrigin: requestPublicOrigin(req),
  });
  res.set("Cache-Control", "private, no-store");
  res.setHeader("Content-Type", exported.mimeType);
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${exported.filename}"; filename*=UTF-8''${encodeURIComponent(exported.filename)}`,
  );
  res.send(exported.buffer);
}

async function previewIncomeOrders(req, res) {
  const filters = parseIncomeExportFilters(req.query);
  const preview = await exportService.previewAccountingIncomeOrders(filters, {
    publicOrigin: requestPublicOrigin(req),
  });
  res.set("Cache-Control", "private, no-store");
  res.json(preview);
}

module.exports = {
  exportIncomeOrders,
  exportIncomeOrdersBundle,
  listIncomeOrders,
  parseIncomeExportFilters,
  parseIncomeOrderFilters,
  previewIncomeOrders,
  previewIncomeOrdersPdf,
  requestPublicOrigin,
};
