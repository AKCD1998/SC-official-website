const crypto = require("node:crypto");
const path = require("node:path");
const pool = require("../../../../db");
const { ApiError, badRequest, conflict } = require("../errors");
const { importConfirmedSalesSources } = require("../db/shopeeConfirmedSalesRepository");
const { importOfficialDocumentSources } = require("../db/shopeeOfficialDocumentRepository");
const { importSalesSources } = require("../db/shopeeSalesSourceRepository");
const { getIngestJob, insertIngestJob } = require("../db/shopeeSalesIngestRepository");
const { readConfirmedSalesSourceBuffer } = require("./shopeeConfirmedSalesService");
const {
  readFinancialStatementSourceBuffer,
  readIncomeSourceBuffer,
  readSellerBalanceSourceBuffer,
} = require("./shopeeOfficialDocumentService");
const { readReturnSourceBuffer } = require("./shopeeReturnSourceService");
const { readSalesSourceBuffer } = require("./shopeeSalesSourceService");
const { requireShopeeShopCode } = require("./shopeeShops");

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const XLSX_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream",
]);
const PDF_MIME_TYPES = new Set(["application/pdf", "application/octet-stream"]);
const ZIP_MIME_TYPES = new Set(["application/zip", "application/x-zip-compressed", "application/octet-stream"]);
const REPORT_TYPES = new Set([
  "business-insights",
  "orders",
  "financial-statement",
  "seller-balance",
  "income-transferred",
  "income-pending",
  "return-refund-cancel",
]);
const XLSX_REPORT_TYPES = new Set([
  "business-insights",
  "orders",
  "seller-balance",
  "income-transferred",
  "income-pending",
]);

function stringField(body, name, maxLength) {
  const value = body?.[name];
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw badRequest(`${name} is required and must not exceed ${maxLength} characters.`);
  }
  return value.trim();
}

function isoDate(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw badRequest(`${name} must use YYYY-MM-DD.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw badRequest(`${name} is not a valid calendar date.`);
  }
  return value;
}

function parseManifest(body) {
  let shopCode;
  try {
    shopCode = requireShopeeShopCode(stringField(body, "shopCode", 40));
  } catch {
    throw badRequest("shopCode is not a supported Shopee shop.");
  }
  const reportType = stringField(body, "reportType", 40);
  if (!REPORT_TYPES.has(reportType)) throw badRequest("reportType is not a supported official Shopee report.");
  const dateFrom = isoDate(stringField(body, "dateFrom", 10), "dateFrom");
  const dateTo = isoDate(stringField(body, "dateTo", 10), "dateTo");
  const dayCount = Math.floor((Date.parse(`${dateTo}T00:00:00Z`) - Date.parse(`${dateFrom}T00:00:00Z`)) / 86400000) + 1;
  if (dayCount < 1 || dayCount > 31) throw badRequest("Source date range must contain 1 to 31 inclusive days.");
  const originalFilename = stringField(body, "originalFilename", 255);
  const requiredExtension = reportType === "financial-statement"
    ? ".pdf"
    : reportType === "return-refund-cancel" ? ".zip" : ".xlsx";
  if (path.basename(originalFilename) !== originalFilename || /[\\/]/u.test(originalFilename)
    || path.extname(originalFilename).toLowerCase() !== requiredExtension) {
    throw badRequest(`originalFilename must be a plain ${requiredExtension} filename for ${reportType}.`);
  }
  const observedAt = stringField(body, "observedAt", 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(observedAt)
    || Number.isNaN(Date.parse(observedAt))) throw badRequest("observedAt must be an ISO timestamp with timezone.");
  isoDate(observedAt.slice(0, 10), "observedAt date");
  const sha256 = stringField(body, "sha256", 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw badRequest("sha256 must contain 64 lowercase hexadecimal characters.");
  const jobId = stringField(body, "jobId", 160);
  if (!/^[A-Za-z0-9._-]{1,160}$/u.test(jobId)) throw badRequest("jobId contains unsupported characters.");
  return { shopCode, reportType, dateFrom, dateTo, dayCount, originalFilename, observedAt, sha256, jobId };
}

function validateUpload(file, manifest) {
  if (!file || !Buffer.isBuffer(file.buffer)) throw badRequest("Exactly one official Shopee source file is required.");
  if (file.size < 1 || file.size > MAX_SOURCE_BYTES) throw badRequest("Shopee source size is outside the supported range.");
  const mime = String(file.mimetype || "").toLowerCase();
  const acceptedMimes = manifest.reportType === "financial-statement"
    ? PDF_MIME_TYPES
    : manifest.reportType === "return-refund-cancel" ? ZIP_MIME_TYPES : XLSX_MIME_TYPES;
  if (!acceptedMimes.has(mime)) throw badRequest("Shopee source MIME type is not accepted for this report.");
  if (file.originalname !== manifest.originalFilename) throw badRequest("Multipart filename does not match originalFilename.");
  if (manifest.reportType === "financial-statement") {
    if (file.buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw badRequest("Financial Statement does not have PDF magic bytes.");
    }
  } else if (file.buffer[0] !== 0x50 || file.buffer[1] !== 0x4b
    || file.buffer[2] !== 0x03 || file.buffer[3] !== 0x04) {
    throw badRequest(XLSX_REPORT_TYPES.has(manifest.reportType)
      ? "Shopee workbook does not have XLSX ZIP magic bytes."
      : "Shopee exceptional-case report does not have ZIP magic bytes.");
  }
  const actualSha256 = crypto.createHash("sha256").update(file.buffer).digest("hex");
  const expected = Buffer.from(manifest.sha256, "hex");
  const actual = Buffer.from(actualSha256, "hex");
  if (!crypto.timingSafeEqual(expected, actual)) throw badRequest("Shopee workbook SHA-256 does not match the manifest.");
}

function sourceValidationError(error) {
  const incomplete = /coverage is incomplete/iu.test(error?.message || "");
  return new ApiError(
    422,
    incomplete
      ? "Shopee source report does not contain every declared day."
      : "Shopee source failed report, shop, date, structure, header, or control validation.",
    incomplete ? "SHOPEE_SOURCE_INCOMPLETE" : "SHOPEE_SOURCE_REJECTED",
    { status: incomplete ? "incomplete" : "rejected" },
  );
}

function sameAuditMetadata(existing, manifest) {
  return existing.shopCode === manifest.shopCode
    && existing.reportType === manifest.reportType
    && existing.sha256 === manifest.sha256
    && existing.sourceFilename === manifest.originalFilename
    && existing.observedAt === new Date(manifest.observedAt).toISOString()
    && existing.dateFrom === manifest.dateFrom
    && existing.dateTo === manifest.dateTo;
}

async function ingestShopeeSalesSource({ body, file }) {
  const manifest = parseManifest(body);
  validateUpload(file, manifest);
  let source;
  try {
    const readers = {
      "business-insights": readConfirmedSalesSourceBuffer,
      orders: readSalesSourceBuffer,
      "financial-statement": readFinancialStatementSourceBuffer,
      "seller-balance": readSellerBalanceSourceBuffer,
      "income-transferred": readIncomeSourceBuffer,
      "income-pending": readIncomeSourceBuffer,
      "return-refund-cancel": readReturnSourceBuffer,
    };
    const reader = readers[manifest.reportType];
    source = await reader(file.buffer, {
      shopCode: manifest.shopCode,
      observedAt: manifest.observedAt,
      reportType: manifest.reportType,
      sourceFilename: manifest.originalFilename,
      sourceSha256: manifest.sha256,
    });
  } catch (error) {
    throw sourceValidationError(error);
  }
  if (source.startDate !== manifest.dateFrom || source.endDate !== manifest.dateTo) {
    throw new ApiError(422, "Shopee source period does not match the manifest.", "SHOPEE_SOURCE_REJECTED", { status: "rejected" });
  }

  const coverage = manifest.reportType === "business-insights"
    ? { coveredDays: source.facts.length, expectedDays: manifest.dayCount }
    : ["financial-statement", "seller-balance", "income-transferred", "income-pending", "return-refund-cancel"]
      .includes(manifest.reportType)
      ? { coveredDays: manifest.dayCount, expectedDays: manifest.dayCount }
      : null;
  const reconciliationStatus = manifest.reportType === "business-insights"
    ? "source_backed"
    : REPORT_TYPES.has(manifest.reportType) && manifest.reportType !== "orders"
      ? "document_validated"
      : "not_checked";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`shopee-sales-ingest:${manifest.jobId}`]);
    const existing = await getIngestJob(client, manifest.jobId);
    if (existing) {
      if (!sameAuditMetadata(existing, manifest)) throw conflict("Existing ingest Job ID has different immutable metadata.");
      await client.query("COMMIT");
      return { ...existing, status: "unchanged" };
    }
    const importer = manifest.reportType === "business-insights"
      ? importConfirmedSalesSources
      : manifest.reportType === "orders" ? importSalesSources : importOfficialDocumentSources;
    const imported = await importer([source], {
      client,
      actor: `shopee-agent:${manifest.jobId}`,
      manageTransaction: false,
    });
    const status = imported.imported === 1 ? "imported" : "unchanged";
    const audit = await insertIngestJob(client, {
      ...manifest,
      status,
      sourceFilename: source.sourceFilename,
      sourceRowCount: source.facts.length,
      reconciliationStatus,
      coverage,
    });
    await client.query("COMMIT");
    return audit;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof ApiError) throw error;
    if (error?.code === "23505"
      || /metadata differs|different shop|relabel|ambiguous overlapping/iu.test(error?.message || "")) {
      throw conflict("Shopee source conflicts with immutable imported evidence.");
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  MAX_SOURCE_BYTES,
  REPORT_TYPES,
  ingestShopeeSalesSource,
  parseManifest,
  sameAuditMetadata,
  sourceValidationError,
  validateUpload,
};
