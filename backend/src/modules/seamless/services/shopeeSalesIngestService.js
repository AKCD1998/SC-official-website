const crypto = require("node:crypto");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
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
const { readEtaxReceiptInvoiceSourceBuffer } = require("./shopeeEtaxReceiptInvoiceService");
const { readSalesSourceBuffer } = require("./shopeeSalesSourceService");
const { requireShopeeShopCode } = require("./shopeeShops");

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_PROVENANCE_JSON_BYTES = 32 * 1024;
const MAX_PROVENANCE_ENTRIES = 12;
const MAX_PROVENANCE_ENTRY_BYTES = 20 * 1024 * 1024;
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
  "etax-receipt-invoice",
]);
const XLSX_REPORT_TYPES = new Set([
  "business-insights",
  "orders",
  "seller-balance",
  "income-transferred",
  "income-pending",
]);
const BASE_MANIFEST_FIELDS = Object.freeze([
  "shopCode", "reportType", "dateFrom", "dateTo", "observedAt", "sha256", "jobId",
]);
const DIRECT_MANIFEST_FIELDS = new Set([...BASE_MANIFEST_FIELDS, "originalFilename"]);
const ETAX_MANIFEST_FIELDS = new Set([
  ...DIRECT_MANIFEST_FIELDS,
  "portalAccount", "sourceValidation",
]);
const ASSEMBLED_MANIFEST_FIELDS = new Set([
  ...BASE_MANIFEST_FIELDS,
  "assembledFromOfficialComponents", "archiveFilename", "sourceOriginalFiles",
]);
const PROVENANCE_FIELDS = new Set([
  "originalFilename", "bytes", "sha256", "kind", "extension", "part", "totalParts",
]);
const RETURN_KIND_ORDER = Object.freeze(["cancelled", "return_refund", "failed_delivery"]);
const RETURN_COMPONENT_PATTERN = /^Order\.(cancelled|return_refund|failed_delivery)\.(\d{8})_(\d{8})_part_(\d+)_of_(\d+)\.(xls|xlsx)$/u;
const ASSEMBLED_ARCHIVE_PATTERN = /^assembled\.Order\.return_refund_cancel\.(\d{8})_(\d{8})\.zip$/u;

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

function compactIsoDate(value) {
  return value.replaceAll("-", "");
}

function addIsoDays(value, days) {
  const instant = new Date(`${value}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

function assertExactFields(body, allowed, mode) {
  const keys = Object.keys(body || {});
  const unexpected = keys.filter((key) => !allowed.has(key));
  if (unexpected.length) {
    throw badRequest(`${mode} manifest contains unsupported fields.`);
  }
}

function integerField(value, name, { min, max }) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw badRequest(`${name} is outside the supported range.`);
  }
  return value;
}

function validatePlainFilename(value, name, extension) {
  if (typeof value !== "string" || !value || value.length > 255
    || path.basename(value) !== value || /[\\/]/u.test(value)
    || path.extname(value).toLowerCase() !== extension) {
    throw badRequest(`${name} must be a plain ${extension} filename.`);
  }
  return value;
}

function parseSourceOriginalFiles(rawValue, { dateFrom, dateTo }) {
  if (typeof rawValue !== "string"
    || Buffer.byteLength(rawValue, "utf8") > MAX_PROVENANCE_JSON_BYTES) {
    throw badRequest("sourceOriginalFiles is malformed or exceeds the supported size.");
  }
  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw badRequest("sourceOriginalFiles must be valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length < 3 || parsed.length > MAX_PROVENANCE_ENTRIES) {
    throw badRequest("sourceOriginalFiles must be a bounded array of official components.");
  }
  const expectedStart = compactIsoDate(dateFrom);
  const expectedExclusiveEnd = compactIsoDate(addIsoDays(dateTo, 1));
  const files = parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).some((key) => !PROVENANCE_FIELDS.has(key))
      || [...PROVENANCE_FIELDS].some((key) => !Object.hasOwn(item, key))) {
      throw badRequest(`sourceOriginalFiles[${index}] has unsupported or missing fields.`);
    }
    const originalFilename = validatePlainFilename(item.originalFilename,
      `sourceOriginalFiles[${index}].originalFilename`, `.${String(item.extension || "").toLowerCase()}`);
    const match = RETURN_COMPONENT_PATTERN.exec(originalFilename);
    if (!match) throw badRequest(`sourceOriginalFiles[${index}] has an unsupported Shopee filename.`);
    const kind = String(item.kind || "");
    const extension = String(item.extension || "").toLowerCase();
    const filenameKind = match[1];
    const filenameExtension = match[6].toLowerCase();
    if (kind !== filenameKind || extension !== filenameExtension
      || match[2] !== expectedStart || match[3] !== expectedExclusiveEnd) {
      throw badRequest(`sourceOriginalFiles[${index}] identity, period, or extension does not match the manifest.`);
    }
    const expectedExtension = kind === "return_refund" ? "xls" : "xlsx";
    if (!RETURN_KIND_ORDER.includes(kind) || extension !== expectedExtension) {
      throw badRequest(`sourceOriginalFiles[${index}] uses an unsupported component format.`);
    }
    const part = integerField(item.part, `sourceOriginalFiles[${index}].part`, { min: 1, max: MAX_PROVENANCE_ENTRIES });
    const totalParts = integerField(item.totalParts, `sourceOriginalFiles[${index}].totalParts`, {
      min: 1, max: MAX_PROVENANCE_ENTRIES,
    });
    if (part > totalParts || Number(match[4]) !== part || Number(match[5]) !== totalParts) {
      throw badRequest(`sourceOriginalFiles[${index}] has inconsistent part metadata.`);
    }
    const bytes = integerField(item.bytes, `sourceOriginalFiles[${index}].bytes`, {
      min: 1, max: MAX_PROVENANCE_ENTRY_BYTES,
    });
    const sha256 = String(item.sha256 || "");
    if (!/^[a-f0-9]{64}$/u.test(sha256)) {
      throw badRequest(`sourceOriginalFiles[${index}].sha256 must be lowercase hexadecimal.`);
    }
    return { originalFilename, bytes, sha256, kind, extension, part, totalParts };
  });
  files.sort((left, right) => RETURN_KIND_ORDER.indexOf(left.kind) - RETURN_KIND_ORDER.indexOf(right.kind)
    || left.part - right.part);
  for (const kind of RETURN_KIND_ORDER) {
    const parts = files.filter((item) => item.kind === kind);
    if (!parts.length) throw badRequest(`sourceOriginalFiles is missing ${kind}.`);
    const totalParts = parts[0].totalParts;
    if (parts.length !== totalParts || parts.some((item) => item.totalParts !== totalParts)
      || parts.some((item, index) => item.part !== index + 1)) {
      throw badRequest(`sourceOriginalFiles ${kind} parts are incomplete or duplicated.`);
    }
  }
  if (new Set(files.map((item) => item.originalFilename.toLowerCase())).size !== files.length) {
    throw badRequest("sourceOriginalFiles contains duplicate filenames.");
  }
  return files;
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
  if (reportType === "etax-receipt-invoice" && dayCount !== 1) {
    throw badRequest("Shopee e-Tax receipt/invoice source must cover exactly one calendar day.");
  }
  const assembled = body?.assembledFromOfficialComponents === "true";
  if (body?.assembledFromOfficialComponents !== undefined && !assembled) {
    throw badRequest("assembledFromOfficialComponents must be exactly true when supplied.");
  }
  const allowedFields = assembled
    ? ASSEMBLED_MANIFEST_FIELDS
    : reportType === "etax-receipt-invoice" ? ETAX_MANIFEST_FIELDS : DIRECT_MANIFEST_FIELDS;
  assertExactFields(body, allowedFields,
    assembled ? "Assembled" : "Direct official");
  if (assembled && reportType !== "return-refund-cancel") {
    throw badRequest("Assembled provenance is supported only for return-refund-cancel.");
  }
  let originalFilename = null;
  let archiveFilename = null;
  let sourceOriginalFiles = null;
  if (assembled) {
    if (body?.originalFilename !== undefined) {
      throw badRequest("Assembled manifest must not fabricate originalFilename.");
    }
    archiveFilename = validatePlainFilename(stringField(body, "archiveFilename", 255), "archiveFilename", ".zip");
    const archiveMatch = ASSEMBLED_ARCHIVE_PATTERN.exec(archiveFilename);
    if (!archiveMatch || archiveMatch[1] !== compactIsoDate(dateFrom)
      || archiveMatch[2] !== compactIsoDate(addIsoDays(dateTo, 1))) {
      throw badRequest("archiveFilename does not match the assembled report period.");
    }
    sourceOriginalFiles = parseSourceOriginalFiles(body.sourceOriginalFiles, { dateFrom, dateTo });
  } else {
    originalFilename = stringField(body, "originalFilename", 255);
  }
  const requiredExtension = reportType === "financial-statement"
    ? ".pdf"
    : ["return-refund-cancel", "etax-receipt-invoice"].includes(reportType) ? ".zip" : ".xlsx";
  if (!assembled && (path.basename(originalFilename) !== originalFilename || /[\\/]/u.test(originalFilename)
    || path.extname(originalFilename).toLowerCase() !== requiredExtension)) {
    throw badRequest(`originalFilename must be a plain ${requiredExtension} filename for ${reportType}.`);
  }
  let portalAccount = null;
  let sourceValidation = null;
  if (reportType === "etax-receipt-invoice") {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-\d{10,16}(?: ?\(\d+\))?\.zip$/iu.test(originalFilename)) {
      throw badRequest("originalFilename is not a recognized Shopee e-Tax archive name.");
    }
    portalAccount = stringField(body, "portalAccount", 40);
    const rawValidation = stringField(body, "sourceValidation", 5_000);
    try {
      sourceValidation = JSON.parse(rawValidation);
    } catch {
      throw badRequest("sourceValidation must be a JSON object for Shopee e-Tax sources.");
    }
    if (!sourceValidation || typeof sourceValidation !== "object" || Array.isArray(sourceValidation)) {
      throw badRequest("sourceValidation must be a JSON object for Shopee e-Tax sources.");
    }
  }
  const observedAt = stringField(body, "observedAt", 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(observedAt)
    || Number.isNaN(Date.parse(observedAt))) throw badRequest("observedAt must be an ISO timestamp with timezone.");
  isoDate(observedAt.slice(0, 10), "observedAt date");
  const sha256 = stringField(body, "sha256", 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw badRequest("sha256 must contain 64 lowercase hexadecimal characters.");
  const jobId = stringField(body, "jobId", 160);
  if (!/^[A-Za-z0-9._-]{1,160}$/u.test(jobId)) throw badRequest("jobId contains unsupported characters.");
  const sourceFilename = assembled ? archiveFilename : originalFilename;
  const assembledProvenance = assembled ? {
    assembledFromOfficialComponents: true,
    archiveFilename,
    sourceFilename,
    sourceOriginalFiles,
  } : null;
  return {
    shopCode, reportType, dateFrom, dateTo, dayCount, originalFilename, archiveFilename,
    sourceFilename, sourceOriginalFiles, assembledFromOfficialComponents: assembled,
    assembledProvenance, observedAt, sha256, jobId, portalAccount, sourceValidation,
  };
}

function multipartFilenameMatches(uploadedFilename, originalFilename) {
  if (uploadedFilename === originalFilename) return true;
  // Busboy/Multer preserves multipart header bytes as latin1. Native FormData sends
  // UTF-8 filename bytes, so Shopee's Thai filenames need one lossless decode at
  // this boundary. The decoded value must still equal the separately signed-in-
  // practice manifest field exactly; no normalization or relabelling is accepted.
  return Buffer.from(String(uploadedFilename || ""), "latin1").toString("utf8") === originalFilename;
}

function validateUpload(file, manifest) {
  if (!file || !Buffer.isBuffer(file.buffer)) throw badRequest("Exactly one official Shopee source file is required.");
  if (file.size < 1 || file.size > MAX_SOURCE_BYTES) throw badRequest("Shopee source size is outside the supported range.");
  const mime = String(file.mimetype || "").toLowerCase();
  const acceptedMimes = manifest.reportType === "financial-statement"
    ? PDF_MIME_TYPES
    : ["return-refund-cancel", "etax-receipt-invoice"].includes(manifest.reportType)
      ? ZIP_MIME_TYPES : XLSX_MIME_TYPES;
  if (!acceptedMimes.has(mime)) throw badRequest("Shopee source MIME type is not accepted for this report.");
  const expectedFilename = manifest.sourceFilename || manifest.originalFilename;
  if (!multipartFilenameMatches(file.originalname, expectedFilename)) {
    throw badRequest(`Multipart filename does not match ${manifest.assembledFromOfficialComponents ? "archiveFilename" : "originalFilename"}.`);
  }
  if (manifest.reportType === "financial-statement") {
    if (file.buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw badRequest("Financial Statement does not have PDF magic bytes.");
    }
  } else {
    const zipMagic = file.buffer[0] === 0x50 && file.buffer[1] === 0x4b;
    const localEntryMagic = zipMagic && file.buffer[2] === 0x03 && file.buffer[3] === 0x04;
    const emptyArchiveMagic = zipMagic && file.buffer[2] === 0x05 && file.buffer[3] === 0x06;
    if (!localEntryMagic
      && !(manifest.reportType === "return-refund-cancel" && emptyArchiveMagic)) {
      throw badRequest(XLSX_REPORT_TYPES.has(manifest.reportType)
        ? "Shopee workbook does not have XLSX ZIP magic bytes."
        : "Shopee exceptional-case report does not have ZIP magic bytes.");
    }
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
    && existing.sourceFilename === manifest.sourceFilename
    && existing.observedAt === new Date(manifest.observedAt).toISOString()
    && existing.dateFrom === manifest.dateFrom
    && existing.dateTo === manifest.dateTo
    && isDeepStrictEqual(existing.assembledProvenance || null, manifest.assembledProvenance || null);
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
      "etax-receipt-invoice": readEtaxReceiptInvoiceSourceBuffer,
    };
    const reader = readers[manifest.reportType];
    source = await reader(file.buffer, {
      shopCode: manifest.shopCode,
      observedAt: manifest.observedAt,
      reportType: manifest.reportType,
      sourceFilename: manifest.sourceFilename,
      sourceSha256: manifest.sha256,
      assembledProvenance: manifest.assembledProvenance,
      startDate: manifest.dateFrom,
      endDate: manifest.dateTo,
      portalAccount: manifest.portalAccount,
      sourceValidation: manifest.sourceValidation,
    });
  } catch (error) {
    throw sourceValidationError(error);
  }
  if (source.startDate !== manifest.dateFrom || source.endDate !== manifest.dateTo) {
    throw new ApiError(422, "Shopee source period does not match the manifest.", "SHOPEE_SOURCE_REJECTED", { status: "rejected" });
  }

  const coverage = manifest.reportType === "business-insights"
    ? { coveredDays: source.facts.length, expectedDays: manifest.dayCount }
    : ["financial-statement", "seller-balance", "income-transferred", "income-pending", "return-refund-cancel", "etax-receipt-invoice"]
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
      assembledProvenance: manifest.assembledProvenance,
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
  MAX_PROVENANCE_JSON_BYTES,
  REPORT_TYPES,
  ingestShopeeSalesSource,
  parseManifest,
  parseSourceOriginalFiles,
  multipartFilenameMatches,
  sameAuditMetadata,
  sourceValidationError,
  validateUpload,
};
