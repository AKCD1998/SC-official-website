const crypto = require("node:crypto");

const INCLUDED_ROWS_MANIFEST_SCHEMA_VERSION = 1;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

function normalizeText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if (typeof value.text === "string") return normalizeText(value.text);
    if (Array.isArray(value.richText)) {
      return normalizeText(value.richText.map((part) => part.text || "").join(""));
    }
    if (Object.prototype.hasOwnProperty.call(value, "result")) {
      return normalizeText(value.result);
    }
  }
  return String(value).normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function normalizeQuantity(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = normalizeText(value).replace(/,/gu, "");
  if (/^-?\d+(?:\.\d+)?$/u.test(text)) return Number(text);
  return text;
}

function canonicalIncludedRow(row) {
  return {
    excelSku: normalizeText(row?.excelSku ?? row?.sku).toUpperCase(),
    orderNumber: normalizeText(row?.orderNumber).toUpperCase(),
    productName: normalizeText(row?.productName),
    quantity: normalizeQuantity(row?.quantity),
    sourceRowNumber: Number(row?.sourceRowNumber),
    status: normalizeText(row?.status),
    variant: normalizeText(row?.variant ?? row?.variation),
  };
}

function digestCanonicalRows(rows) {
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function buildIncludedRowsManifest(rows) {
  const canonicalRows = (Array.isArray(rows) ? rows : [])
    .map(canonicalIncludedRow)
    .sort((left, right) => left.sourceRowNumber - right.sourceRowNumber);
  const sourceRowNumbers = canonicalRows.map((row) => row.sourceRowNumber);

  if (sourceRowNumbers.some((value) => !Number.isSafeInteger(value) || value < 2)) {
    throw new Error("Included-row manifest requires valid source row numbers.");
  }
  if (new Set(sourceRowNumbers).size !== sourceRowNumbers.length) {
    throw new Error("Included-row manifest cannot contain duplicate source row numbers.");
  }

  return {
    contentDigestSha256: digestCanonicalRows(canonicalRows),
    rowCount: canonicalRows.length,
    schemaVersion: INCLUDED_ROWS_MANIFEST_SCHEMA_VERSION,
    sourceRowNumbers,
  };
}

function parseIncludedRowsManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sourceRowNumbers = Array.isArray(value.sourceRowNumbers)
    ? value.sourceRowNumbers.map(Number)
    : null;
  if (!sourceRowNumbers
    || value.schemaVersion !== INCLUDED_ROWS_MANIFEST_SCHEMA_VERSION
    || !Number.isSafeInteger(value.rowCount)
    || value.rowCount !== sourceRowNumbers.length
    || !DIGEST_PATTERN.test(String(value.contentDigestSha256 || "").toLowerCase())
    || sourceRowNumbers.some((rowNumber) => !Number.isSafeInteger(rowNumber) || rowNumber < 2)
    || new Set(sourceRowNumbers).size !== sourceRowNumbers.length
    || sourceRowNumbers.some((rowNumber, index) => index > 0 && rowNumber <= sourceRowNumbers[index - 1])) {
    return null;
  }

  return {
    contentDigestSha256: String(value.contentDigestSha256).toLowerCase(),
    rowCount: value.rowCount,
    schemaVersion: value.schemaVersion,
    sourceRowNumbers,
  };
}

function includedRowsManifestsEqual(left, right) {
  return Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));
}

module.exports = {
  INCLUDED_ROWS_MANIFEST_SCHEMA_VERSION,
  buildIncludedRowsManifest,
  includedRowsManifestsEqual,
  parseIncludedRowsManifest,
};
