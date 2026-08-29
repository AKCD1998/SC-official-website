const crypto = require("node:crypto");

const MAX_RESOLVE_SKUS = 500;

function normalizeCompanySku(value) {
  return String(value || "").normalize("NFKC").trim();
}

function collectShopeeCompanySkus(catalog) {
  if (catalog?.schemaVersion !== 1 || !catalog?.catalogVersion || !Array.isArray(catalog?.records)) {
    throw new Error("Shopee product catalog schema is invalid.");
  }
  const companySkus = new Set();
  catalog.records.forEach((record) => {
    if (record?.match?.status === "matched") {
      companySkus.add(normalizeCompanySku(record.match.companySku));
    }
    if (record?.match?.status === "bundle") {
      (record.match.components || []).forEach((component) => {
        companySkus.add(normalizeCompanySku(component.companySku));
      });
    }
  });
  companySkus.delete("");
  const sorted = [...companySkus].sort((left, right) => left.localeCompare(right, "en"));
  if (!sorted.length || sorted.length > MAX_RESOLVE_SKUS) {
    throw new Error(`Shopee product catalog must reference between 1 and ${MAX_RESOLVE_SKUS} Company SKUs.`);
  }
  return sorted;
}

function canonicalErpRecord(record) {
  const companySku = normalizeCompanySku(record?.companySku);
  if (!companySku || !String(record?.displayName || "").trim()) {
    throw new Error("ERP product catalog returned an invalid product record.");
  }
  const barcodes = Array.isArray(record.barcodes)
    ? record.barcodes.map((value) => String(value)).sort()
    : [];
  return {
    barcodes,
    companySku,
    displayName: String(record.displayName).trim(),
    productKind: String(record.productKind || "").trim() || null,
    updatedAt: record.updatedAt ? new Date(record.updatedAt).toISOString() : null,
  };
}

function checksumRecords(records) {
  return crypto.createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

function validateErpResponse(body, requestedCompanySkus) {
  if (body?.schemaVersion !== 1 || body?.source !== "sc-erp-product-master") {
    throw new Error("ERP product catalog contract is unsupported.");
  }
  if (!Array.isArray(body.records) || !Array.isArray(body.missingCompanySkus)) {
    throw new Error("ERP product catalog response is incomplete.");
  }

  const requested = new Set(requestedCompanySkus);
  const seen = new Set();
  const records = body.records.map(canonicalErpRecord);
  records.forEach((record) => {
    if (!requested.has(record.companySku) || seen.has(record.companySku)) {
      throw new Error("ERP product catalog returned an unexpected or duplicate Company SKU.");
    }
    seen.add(record.companySku);
  });
  const missingCompanySkus = body.missingCompanySkus.map(normalizeCompanySku).sort();
  const missingSet = new Set(missingCompanySkus);
  if (missingSet.size !== missingCompanySkus.length
    || missingCompanySkus.some((companySku) => !requested.has(companySku) || seen.has(companySku))) {
    throw new Error("ERP product catalog returned an invalid missing-SKU list.");
  }
  if (Number(body.requestedCount) !== requestedCompanySkus.length
    || Number(body.resolvedCount) !== records.length
    || records.length + missingCompanySkus.length !== requestedCompanySkus.length) {
    throw new Error("ERP product catalog counts do not reconcile.");
  }
  if (requestedCompanySkus.some((companySku) => !seen.has(companySku) && !missingSet.has(companySku))) {
    throw new Error("ERP product catalog omitted a requested Company SKU.");
  }
  if (!/^[a-f0-9]{64}$/u.test(String(body.sourceChecksum || ""))
    || checksumRecords(records) !== body.sourceChecksum) {
    throw new Error("ERP product catalog checksum validation failed.");
  }
  return { missingCompanySkus, records, sourceChecksum: body.sourceChecksum };
}

async function verifyShopeeCatalogAgainstErp({
  catalog,
  fetchImpl = global.fetch,
  internalToken,
  resolveUrl,
  timeoutMs = 15_000,
} = {}) {
  const companySkus = collectShopeeCompanySkus(catalog);
  const verified = await resolveCompanySkusAgainstErp({
    companySkus,
    fetchImpl,
    internalToken,
    resolveUrl,
    timeoutMs,
  });
  if (verified.missingCompanySkus.length) {
    const error = new Error("Shopee catalog references Company SKUs missing from ERP master.");
    error.code = "ERP_SKUS_MISSING";
    error.missingCompanySkus = verified.missingCompanySkus;
    throw error;
  }
  return {
    catalogVersion: catalog.catalogVersion,
    checkedCompanySkuCount: companySkus.length,
    erpSourceChecksum: verified.sourceChecksum,
    resolvedCompanySkuCount: verified.records.length,
  };
}

async function resolveCompanySkusAgainstErp({
  companySkus,
  fetchImpl = global.fetch,
  internalToken,
  resolveUrl,
  timeoutMs = 15_000,
} = {}) {
  const endpoint = String(resolveUrl || "").trim();
  const token = String(internalToken || "").trim();
  if (!/^https:\/\//iu.test(endpoint)) throw new Error("ERP product catalog URL must use HTTPS.");
  if (!token) throw new Error("ERP product catalog token is required.");
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");

  const normalizedCompanySkus = [...new Set((Array.isArray(companySkus) ? companySkus : [])
    .map(normalizeCompanySku)
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "en"));
  if (!normalizedCompanySkus.length || normalizedCompanySkus.length > MAX_RESOLVE_SKUS) {
    throw new Error(`ERP resolution requires between 1 and ${MAX_RESOLVE_SKUS} Company SKUs.`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": token,
      },
      body: JSON.stringify({ companySkus: normalizedCompanySkus }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`ERP product catalog request failed with HTTP ${response.status}.`);
  }
  return validateErpResponse(await response.json(), normalizedCompanySkus);
}

module.exports = {
  MAX_RESOLVE_SKUS,
  checksumRecords,
  collectShopeeCompanySkus,
  resolveCompanySkusAgainstErp,
  validateErpResponse,
  verifyShopeeCatalogAgainstErp,
};
