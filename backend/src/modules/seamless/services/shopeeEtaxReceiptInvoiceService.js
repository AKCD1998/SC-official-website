const { unzipSync } = require("fflate");
const { requireShopeeShopCode, SHOPEE_SHOP_PROFILES } = require("./shopeeShops");

const MAX_ENTRY_COUNT = 100;
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

function dateToken(value) {
  return String(value || "").replaceAll("-", "").slice(2);
}

function readEtaxReceiptInvoiceSourceBuffer(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error("Shopee e-Tax source must be a non-empty ZIP archive.");
  }
  const shopCode = requireShopeeShopCode(options.shopCode);
  const profile = SHOPEE_SHOP_PROFILES[shopCode];
  if (options.reportType !== "etax-receipt-invoice") {
    throw new Error("Shopee e-Tax source has the wrong report type.");
  }
  if (options.startDate !== options.endDate || !/^\d{4}-\d{2}-\d{2}$/u.test(String(options.startDate || ""))) {
    throw new Error("Shopee e-Tax source must cover exactly one declared calendar day.");
  }
  if (options.portalAccount !== profile.statisticsUsername) {
    throw new Error("Shopee e-Tax portal account does not match the declared shop.");
  }

  let entryCount = 0;
  let totalPdfBytes = 0;
  const expectedToken = dateToken(options.startDate);
  const issuers = new Set();
  let entries;
  try {
    entries = unzipSync(new Uint8Array(buffer), {
      filter(file) {
        entryCount += 1;
        if (
          entryCount > MAX_ENTRY_COUNT
          || file.name.includes("/")
          || file.name.includes("\\")
          || file.name.startsWith(".")
          || !/\.pdf$/iu.test(file.name)
          || !file.name.includes(`-${expectedToken}-`)
          || file.originalSize < 128
          || file.originalSize > MAX_ENTRY_BYTES
        ) {
          throw new Error("Unsafe or mismatched Shopee e-Tax ZIP entry.");
        }
        totalPdfBytes += file.originalSize;
        if (totalPdfBytes > MAX_UNCOMPRESSED_BYTES) {
          throw new Error("Shopee e-Tax ZIP expands beyond the supported limit.");
        }
        return true;
      },
    });
  } catch (error) {
    throw new Error(`Shopee e-Tax ZIP validation failed: ${error.message}`);
  }
  const names = Object.keys(entries || {});
  if (!entryCount || names.length !== entryCount) {
    throw new Error("Shopee e-Tax ZIP is empty or incomplete.");
  }
  for (const name of names) {
    const pdf = Buffer.from(entries[name]);
    const tail = pdf.subarray(Math.max(0, pdf.length - 4_096)).toString("latin1");
    if (!/^%PDF-1\.[0-7]/u.test(pdf.subarray(0, 8).toString("latin1"))
      || !/%%EOF[\u0000\t\r\n ]*$/u.test(tail)) {
      throw new Error("Shopee e-Tax ZIP contains an invalid or incomplete PDF.");
    }
    const issuer = name.split("-", 1)[0].trim();
    if (issuer) issuers.add(issuer.slice(0, 80));
  }

  const supplied = options.sourceValidation || {};
  if (
    supplied.portalAccount !== profile.statisticsUsername
    || supplied.selectedDate !== options.startDate
    || Number(supplied.archiveEntryCount) !== entryCount
    || supplied.allEntriesArePdf !== true
    || supplied.allEntryDatesMatch !== true
  ) {
    throw new Error("Shopee e-Tax agent validation evidence does not match the archive.");
  }

  return {
    shopCode,
    reportType: "etax-receipt-invoice",
    sourceFilename: options.sourceFilename,
    sourceSha256: options.sourceSha256,
    observedAt: new Date(options.observedAt).toISOString(),
    startDate: options.startDate,
    endDate: options.endDate,
    facts: [],
    control: {
      documentCount: entryCount,
      totalPdfBytes,
      issuers: [...issuers].sort(),
      portalAccount: profile.statisticsUsername,
      selectedDate: options.startDate,
      rawArchiveRetention: "hq-agent-only",
      validationMethod: "trusted-agent-portal-account+zip-entry-date+pdf-container",
    },
  };
}

module.exports = {
  MAX_ENTRY_BYTES,
  MAX_ENTRY_COUNT,
  MAX_UNCOMPRESSED_BYTES,
  readEtaxReceiptInvoiceSourceBuffer,
};
