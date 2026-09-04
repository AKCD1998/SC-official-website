const crypto = require("node:crypto");
const barcodeRegistry = require("../data/shopeePrimaryBarcode.v1.json");

const BARCODE_PATTERN = /^\d{6,18}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function normalizeCompanySku(value) {
  return String(value || "").normalize("NFKC").trim().toUpperCase();
}

function checksumRecords(records) {
  return crypto.createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

function buildPrimaryBarcodeIndex(registry = barcodeRegistry) {
  if (
    registry?.schemaVersion !== 1
    || !String(registry?.registryVersion || "").trim()
    || !Array.isArray(registry?.records)
    || !SHA256_PATTERN.test(String(registry?.sourceChecksumSha256 || ""))
    || checksumRecords(registry.records) !== registry.sourceChecksumSha256
  ) {
    throw new Error("Shopee primary barcode registry schema or checksum is invalid.");
  }

  const index = new Map();
  const barcodeOwners = new Map();
  registry.records.forEach((record) => {
    const companySku = normalizeCompanySku(record?.companySku);
    const primaryBarcode = String(record?.primaryBarcode || "").trim();
    if (!companySku || !BARCODE_PATTERN.test(primaryBarcode) || index.has(companySku)) {
      throw new Error("Shopee primary barcode registry contains an invalid or duplicate record.");
    }
    if (barcodeOwners.has(primaryBarcode)) {
      throw new Error("Shopee primary barcode registry contains a duplicate primary barcode.");
    }
    barcodeOwners.set(primaryBarcode, companySku);
    index.set(companySku, primaryBarcode);
  });
  return index;
}

const primaryBarcodeIndex = buildPrimaryBarcodeIndex();

function getPrimaryBarcode(companySku) {
  return primaryBarcodeIndex.get(normalizeCompanySku(companySku)) || null;
}

module.exports = {
  BARCODE_PATTERN,
  buildPrimaryBarcodeIndex,
  checksumRecords,
  getPrimaryBarcode,
  normalizeCompanySku,
};
