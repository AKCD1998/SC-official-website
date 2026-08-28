const catalog = require("../src/modules/seamless/data/shopeeProductCatalog.v1.json");
const {
  enrichShopeeOrderItems,
  getShopeeProductCatalogSummary,
  matchShopeeProduct,
  normalizeShopeeProductText,
  summarizeShopeeProductMatches,
} = require("../src/modules/seamless/services/shopeeProductMatcher");

test("loads the complete hash-verified Shopee product catalog", () => {
  expect(getShopeeProductCatalogSummary()).toEqual({
    catalogVersion: "shopee-company-sku-2026-08-28",
    ownerDecisionDate: "2026-08-28",
    recordCount: 227,
    sourceCount: 2,
  });
  expect(catalog.records.filter((record) => record.match.status === "matched")).toHaveLength(223);
  expect(catalog.records.filter((record) => record.match.status === "bundle")).toHaveLength(3);
  expect(catalog.records.filter((record) => record.match.status === "visibility_only")).toHaveLength(1);
});

test("every catalog record round-trips through exact shop/name/variant matching", () => {
  catalog.records.forEach((record) => {
    const match = matchShopeeProduct(record.shopCode, {
      name: record.productName,
      variant: record.variant,
    });
    expect(match.status).toBe(record.match.status);
    expect(match.listingProductId).toBe(record.productId);
    expect(match.listingVariationId).toBe(record.variationId);
    if (record.match.status === "matched") expect(match.companySku).toBe(record.match.companySku);
  });
});

test("normalizes Unicode and whitespace without fuzzy product matching", () => {
  const record = catalog.records.find((candidate) => (
    candidate.shopCode === "dr-morepen" && candidate.sourceRow === 7
  ));
  const match = matchShopeeProduct("dr-morepen", {
    name: `  ${record.productName.replace(/ /gu, "   ")}  `,
    variant: "",
  });

  expect(normalizeShopeeProductText("  TEST\u00a0Product ")).toBe("test product");
  expect(match).toMatchObject({
    status: "matched",
    companySku: "IC-005998",
    matchSource: "exact_name_variant",
  });
  expect(matchShopeeProduct("sc-drug-store", {
    name: record.productName,
    variant: record.variant,
  })).toMatchObject({ status: "unmapped", reasonCode: "catalog_identity_not_found" });
});

test("uses the corrected Company SKU instead of the stale Shopee workbook value", () => {
  const record = catalog.records.find((candidate) => (
    candidate.shopCode === "sc-drug-store" && candidate.sourceRow === 33
  ));
  expect(matchShopeeProduct(record.shopCode, {
    name: record.productName,
    variant: record.variant,
  })).toMatchObject({
    status: "matched",
    companySku: "IC-001849",
    listingProductId: "56562041161",
    listingVariationId: "436046531380",
  });
});

test("returns component mappings and keeps unverified bundle quantities in manual review", () => {
  const drBundle = catalog.records.find((candidate) => (
    candidate.shopCode === "dr-morepen" && candidate.sourceRow === 11
  ));
  const items = enrichShopeeOrderItems(drBundle.shopCode, [{
    name: drBundle.productName,
    variant: drBundle.variant,
    quantity: 1,
    unitPrice: 350,
  }]);

  expect(items[0].productMatch).toMatchObject({
    status: "bundle",
    quantityRuleStatus: "requires_validation",
    components: [
      { companySku: "IC-003230", quantityPerSale: null },
      { companySku: "IC-003478", quantityPerSale: null },
    ],
  });
  expect(summarizeShopeeProductMatches(items)).toMatchObject({
    bundleItems: 1,
    coverageComplete: true,
    manualReviewRequired: true,
    unmappedItems: 0,
  });
});

test("returns the verified Candy Pop component expansion without fabricating one SKU", () => {
  const candyBundle = catalog.records.find((candidate) => (
    candidate.shopCode === "sc-drug-store" && candidate.sourceRow === 115
  ));
  const item = enrichShopeeOrderItems(candyBundle.shopCode, [{
    name: candyBundle.productName,
    variant: candyBundle.variant,
  }])[0];

  expect(item.productMatch).toMatchObject({
    status: "bundle",
    sellerBundleKey: "SC-BND-CANDYPOP-MIX3-V1",
    quantityRuleStatus: "verified",
    components: [
      { companySku: "IC-005598", quantityPerSale: 1 },
      { companySku: "IC-005323", quantityPerSale: 1 },
      { companySku: "IC-005294", quantityPerSale: 1 },
    ],
  });
  expect(item.productMatch.companySku).toBeUndefined();
});

test("classifies the never-sold Strepsils listing for fail-closed review", () => {
  const visibilityOnly = catalog.records.find((candidate) => (
    candidate.shopCode === "sc-drug-store" && candidate.sourceRow === 182
  ));
  const item = enrichShopeeOrderItems(visibilityOnly.shopCode, [{
    name: visibilityOnly.productName,
    variant: visibilityOnly.variant,
  }])[0];

  expect(item.productMatch).toMatchObject({
    status: "visibility_only",
    reasonCode: "never_sold_visibility_listing",
  });
  expect(summarizeShopeeProductMatches([item])).toMatchObject({
    coverageComplete: true,
    manualReviewRequired: true,
    visibilityOnlyItems: 1,
  });
});

test("requires a variation for multi-variation listings and flags empty orders", () => {
  const multiVariation = catalog.records.find((candidate) => (
    candidate.shopCode === "sc-drug-store" && candidate.sourceRow === 8
  ));
  expect(matchShopeeProduct(multiVariation.shopCode, {
    name: multiVariation.productName,
    variant: "",
  })).toMatchObject({ status: "unmapped", reasonCode: "variant_required" });
  expect(summarizeShopeeProductMatches([])).toMatchObject({
    totalItems: 0,
    coverageComplete: false,
    manualReviewRequired: true,
  });
});
