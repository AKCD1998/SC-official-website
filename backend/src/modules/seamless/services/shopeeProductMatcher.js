const crypto = require("node:crypto");
const catalog = require("../data/shopeeProductCatalog.v1.json");
const { normalizeShopeeShopCode } = require("./shopeeShops");

const SUPPORTED_MATCH_STATUSES = new Set(["matched", "bundle", "visibility_only"]);

function normalizeShopeeProductText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\u00a0/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function identityKey(shopCode, productName, variant) {
  return JSON.stringify([
    normalizeShopeeShopCode(shopCode),
    normalizeShopeeProductText(productName),
    normalizeShopeeProductText(variant),
  ]);
}

function nameKey(shopCode, productName) {
  return JSON.stringify([
    normalizeShopeeShopCode(shopCode),
    normalizeShopeeProductText(productName),
  ]);
}

function validateCatalogRecord(record) {
  if (!normalizeShopeeShopCode(record?.shopCode)) {
    throw new Error("Shopee product catalog contains an unsupported shop code.");
  }
  if (!normalizeShopeeProductText(record?.productName) || !String(record?.productId || "").trim()) {
    throw new Error(`Shopee product catalog row ${record?.sourceRow || "?"} has incomplete identity data.`);
  }
  if (!SUPPORTED_MATCH_STATUSES.has(record?.match?.status)) {
    throw new Error(`Shopee product catalog row ${record?.sourceRow || "?"} has an unsupported match status.`);
  }
  if (record.match.status === "matched" && !String(record.match.companySku || "").trim()) {
    throw new Error(`Shopee product catalog row ${record.sourceRow} is missing its Company SKU.`);
  }
  if (record.match.status === "bundle" && !record.match.components?.length) {
    throw new Error(`Shopee product catalog row ${record.sourceRow} is missing bundle components.`);
  }
}

function buildIndexes() {
  if (catalog?.schemaVersion !== 1 || !catalog?.catalogVersion || !Array.isArray(catalog?.records)) {
    throw new Error("Shopee product catalog schema is invalid.");
  }

  const exact = new Map();
  const byName = new Map();
  catalog.records.forEach((record) => {
    validateCatalogRecord(record);
    const exactKey = identityKey(record.shopCode, record.productName, record.variant);
    if (exact.has(exactKey)) {
      throw new Error(
        `Shopee product catalog has a duplicate normalized identity at rows ${exact.get(exactKey).sourceRow} and ${record.sourceRow}.`,
      );
    }
    exact.set(exactKey, record);

    const productNameKey = nameKey(record.shopCode, record.productName);
    const records = byName.get(productNameKey) || [];
    records.push(record);
    byName.set(productNameKey, records);
  });

  return { exact, byName };
}

const indexes = buildIndexes();

function publicMatch(record, matchSource) {
  const base = {
    catalogVersion: catalog.catalogVersion,
    status: record.match.status,
    matchSource,
    listingProductId: String(record.productId),
    listingVariationId: String(record.variationId),
  };
  if (record.match.status === "matched") {
    return { ...base, companySku: String(record.match.companySku) };
  }
  if (record.match.status === "bundle") {
    return {
      ...base,
      ...(record.match.sellerBundleKey ? { sellerBundleKey: record.match.sellerBundleKey } : {}),
      components: record.match.components.map((component) => ({
        companySku: String(component.companySku),
        quantityPerSale: Number.isInteger(component.quantityPerSale)
          ? component.quantityPerSale
          : null,
      })),
      quantityRuleStatus: record.match.quantityRuleStatus || "requires_validation",
    };
  }
  return { ...base, reasonCode: record.match.reasonCode || "visibility_only" };
}

function unmatched(reasonCode) {
  return {
    catalogVersion: catalog.catalogVersion,
    status: "unmapped",
    reasonCode,
  };
}

function matchShopeeProduct(shopCodeValue, item) {
  const shopCode = normalizeShopeeShopCode(shopCodeValue);
  const productName = normalizeShopeeProductText(item?.name);
  const variant = normalizeShopeeProductText(item?.variant);
  if (!shopCode) return unmatched("unsupported_shop");
  if (!productName) return unmatched("missing_product_name");

  const exactRecord = indexes.exact.get(identityKey(shopCode, productName, variant));
  if (exactRecord) return publicMatch(exactRecord, "exact_name_variant");

  if (!variant) {
    const sameNameRecords = indexes.byName.get(nameKey(shopCode, productName)) || [];
    if (sameNameRecords.length === 1) {
      return publicMatch(sameNameRecords[0], "unique_name");
    }
    if (sameNameRecords.length > 1) return unmatched("variant_required");
  }

  return unmatched("catalog_identity_not_found");
}

function enrichShopeeOrderItems(shopCode, items) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    ...item,
    productMatch: matchShopeeProduct(shopCode, item),
  }));
}

function summarizeShopeeProductMatches(items) {
  const summary = {
    catalogVersion: catalog.catalogVersion,
    totalItems: 0,
    matchedItems: 0,
    bundleItems: 0,
    visibilityOnlyItems: 0,
    unmappedItems: 0,
    coverageComplete: false,
    manualReviewRequired: false,
  };

  (Array.isArray(items) ? items : []).forEach((item) => {
    summary.totalItems += 1;
    const match = item?.productMatch;
    if (match?.status === "matched") summary.matchedItems += 1;
    else if (match?.status === "bundle") {
      summary.bundleItems += 1;
      if (match.quantityRuleStatus !== "verified") summary.manualReviewRequired = true;
    } else if (match?.status === "visibility_only") {
      summary.visibilityOnlyItems += 1;
      summary.manualReviewRequired = true;
    } else {
      summary.unmappedItems += 1;
      summary.manualReviewRequired = true;
    }
  });

  summary.coverageComplete = summary.totalItems > 0 && summary.unmappedItems === 0;
  if (!summary.totalItems) summary.manualReviewRequired = true;
  return summary;
}

function getShopeeProductCatalogSummary() {
  return {
    catalogVersion: catalog.catalogVersion,
    ownerDecisionDate: catalog.ownerDecisionDate,
    recordCount: catalog.records.length,
    sourceCount: catalog.sources.length,
  };
}

function getShopeeProductCatalogDigest() {
  return crypto.createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
}

module.exports = {
  enrichShopeeOrderItems,
  getShopeeProductCatalogDigest,
  getShopeeProductCatalogSummary,
  matchShopeeProduct,
  normalizeShopeeProductText,
  summarizeShopeeProductMatches,
};
