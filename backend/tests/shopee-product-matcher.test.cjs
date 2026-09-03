const catalog = require("../src/modules/seamless/data/shopeeProductCatalog.v1.json");
const productAliases = require("../src/modules/seamless/data/shopeeProductAliases.v1.json");
const {
  enrichShopeeOrderItems,
  getShopeeProductCatalogSummary,
  matchShopeeProduct,
  normalizeShopeeProductText,
  summarizeShopeeProductMatches,
} = require("../src/modules/seamless/services/shopeeProductMatcher");

test("loads the complete hash-verified Shopee product catalog", () => {
  expect(getShopeeProductCatalogSummary()).toEqual({
    automaticQuantityReviewCount: 4,
    automaticQuantityRuleCount: 77,
    automaticQuantityRuleVersion: "same-sku-anchor-or-erp-unit-factor-v3",
    catalogVersion: "shopee-company-sku-2026-09-03",
    ownerDecisionDate: "2026-09-03",
    recordCount: 227,
    sourceCount: 2,
  });
  expect(catalog.records.filter((record) => record.match.status === "matched")).toHaveLength(222);
  expect(catalog.records.filter((record) => record.match.status === "bundle")).toHaveLength(4);
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

test("expands the DR.Morepen three-box variation to three units of the same Company SKU", () => {
  const drThreeBoxBundle = catalog.records.find((candidate) => (
    candidate.shopCode === "dr-morepen" && candidate.sourceRow === 8
  ));
  const item = enrichShopeeOrderItems(drThreeBoxBundle.shopCode, [{
    name: drThreeBoxBundle.productName,
    quantity: 1,
    variant: drThreeBoxBundle.variant,
  }])[0];

  expect(item.productMatch).toMatchObject({
    status: "bundle",
    sellerBundleKey: "DR-BND-BG03-STRIP25-X3-V1",
    quantityRuleStatus: "verified",
    components: [{ companySku: "IC-003478", quantityPerSale: 3 }],
  });
});

test.each([
  [154, "IC-003493", 6, "bar"],
  [61, "IC-005014", 2, "can"],
  [75, "IC-001230", 3, "box"],
  [102, "630010147", 50, "blister"],
  [62, "IC-004199", 5, "sachet"],
])("infers a high-confidence same-SKU multipack for catalog row %s", (
  sourceRow,
  companySku,
  quantityPerSale,
  quantityUnit,
) => {
  const record = catalog.records.find((candidate) => (
    candidate.shopCode === "sc-drug-store" && candidate.sourceRow === sourceRow
  ));
  const match = matchShopeeProduct(record.shopCode, {
    name: record.productName,
    variant: record.variant,
  });

  expect(match).toMatchObject({
    status: "matched",
    companySku,
    isMultipack: true,
    quantityPerSale,
    quantityRuleSource: "catalog_same_sku_explicit_unit_anchor",
    quantityRuleStatus: "verified",
    quantityUnit,
  });
});

test("expands every validated Vita-C sachet variation into base sachet units", () => {
  const validatedSkus = new Set([
    "IC-001510",
    "IC-001849",
    "IC-002300",
    "IC-002353",
    "IC-002484",
    "IC-002485",
    "IC-002516",
  ]);
  const records = catalog.records.filter((candidate) => (
    candidate.shopCode === "sc-drug-store"
    && candidate.match.status === "matched"
    && validatedSkus.has(candidate.match.companySku)
  ));

  expect(records).toHaveLength(31);
  records.forEach((record) => {
    const match = matchShopeeProduct(record.shopCode, {
      name: record.productName,
      variant: record.variant,
    });
    const expectedQuantity = record.variant.includes("24+1")
      ? 25
      : Number(record.variant.match(/\d+/u)?.[0]);
    expect(match).toMatchObject({
      status: "matched",
      companySku: record.match.companySku,
      isMultipack: true,
      quantityPerSale: expectedQuantity,
      quantityRuleSource: "erp_validated_sku_base_unit",
      quantityRuleStatus: "verified",
      quantityUnit: "sachet",
    });
  });
});

test("maps mixed Vita-C jar variations to the dedicated bottle SKUs", () => {
  const expectedSkus = new Map([
    [52, "IC-002912"],
    [53, "IC-002913"],
    [56, "IC-002911"],
    [58, "IC-002910"],
  ]);

  expectedSkus.forEach((companySku, sourceRow) => {
    const record = catalog.records.find((candidate) => (
      candidate.shopCode === "sc-drug-store" && candidate.sourceRow === sourceRow
    ));
    expect(matchShopeeProduct(record.shopCode, {
      name: record.productName,
      variant: record.variant,
    })).toMatchObject({ status: "matched", companySku });
  });
});

test("matches the historical Vita-C Gummy EXP title through its canonical name alias", () => {
  const alias = productAliases.aliases[0];
  const canonicalRecords = catalog.records.filter((candidate) => (
    candidate.shopCode === alias.shopCode
    && candidate.productName === alias.canonicalProductName
  ));

  expect(canonicalRecords).toHaveLength(3);
  canonicalRecords.forEach((record) => {
    const match = matchShopeeProduct(alias.shopCode, {
      name: alias.aliasProductName,
      variant: record.variant,
    });
    expect(match).toMatchObject({
      status: "matched",
      companySku: "IC-001510",
      matchSource: "catalog_name_alias",
      quantityRuleStatus: "verified",
      quantityUnit: "sachet",
    });
  });
});

test("maps the owner-confirmed historical INTRASITE 15g title typo to the 25g SKU", () => {
  const alias = productAliases.aliases.find((candidate) => (
    candidate.reasonCode === "seller_title_size_typo_owner_confirmed"
  ));

  expect(matchShopeeProduct(alias.shopCode, {
    name: alias.aliasProductName,
    variant: "1 กล่อง",
  })).toMatchObject({
    status: "matched",
    companySku: "IC-000330",
    matchSource: "catalog_name_alias",
  });

  expect(matchShopeeProduct(alias.shopCode, {
    name: alias.aliasProductName,
    variant: "3 กล่อง",
  })).toMatchObject({
    status: "matched",
    companySku: "IC-000330",
    matchSource: "catalog_name_alias",
    quantityRuleStatus: "verified",
    quantityPerSale: 3,
    quantityUnit: "box",
  });
});

test("maps the owner-confirmed historical Colosure title and variant identity", () => {
  const alias = productAliases.aliases.find((candidate) => (
    candidate.reasonCode === "historical_listing_identity_owner_confirmed"
  ));

  expect(matchShopeeProduct(alias.shopCode, {
    name: alias.aliasProductName,
    variant: alias.aliasVariant,
  })).toMatchObject({
    status: "matched",
    companySku: "IC-005104",
    matchSource: "catalog_identity_alias",
    quantityUnit: "can",
  });
});

test("ignores the owner-confirmed legacy BioMag placeholder variant", () => {
  const alias = productAliases.aliases.find((candidate) => (
    candidate.reasonCode === "legacy_placeholder_variant_owner_confirmed"
  ));

  const match = matchShopeeProduct(alias.shopCode, {
    name: alias.aliasProductName,
    variant: alias.aliasVariant,
  });
  expect(match).toMatchObject({
    status: "matched",
    companySku: "IC-005370",
    matchSource: "catalog_identity_alias",
    quantityUnit: "box",
  });
  expect(match).not.toHaveProperty("quantityPerSale");
});

test("maps the shortened historical Polar variant using its 280 ml product identity", () => {
  const alias = productAliases.aliases.find((candidate) => (
    candidate.reasonCode === "historical_shortened_variant_owner_confirmed"
  ));

  expect(matchShopeeProduct(alias.shopCode, {
    name: alias.aliasProductName,
    variant: alias.aliasVariant,
  })).toMatchObject({
    status: "matched",
    companySku: "IC-002462",
    matchSource: "catalog_identity_alias",
    quantityUnit: "can",
  });
});

test("maps confirmed legacy Deeday expiry variants to their single selling packs", () => {
  const fiberAlias = productAliases.aliases.find((candidate) => (
    candidate.reasonCode === "historical_single_box_variant_owner_confirmed"
  ));
  const bioCAlias = productAliases.aliases.find((candidate) => (
    candidate.reasonCode === "historical_single_unit_variant_owner_confirmed"
  ));

  expect(matchShopeeProduct(fiberAlias.shopCode, {
    name: fiberAlias.aliasProductName,
    variant: fiberAlias.aliasVariant,
  })).toMatchObject({
    status: "matched",
    companySku: "IC-005371",
    matchSource: "catalog_identity_alias",
    quantityPerSale: 10,
    quantityRuleSource: "erp_validated_sku_unit_factor",
    quantityRuleStatus: "verified",
    quantityUnit: "sachet",
  });
  expect(matchShopeeProduct(bioCAlias.shopCode, {
    name: bioCAlias.aliasProductName,
    variant: bioCAlias.aliasVariant,
  })).toMatchObject({
    status: "matched",
    companySku: "IC-005372",
    matchSource: "catalog_identity_alias",
    quantityUnit: "box",
  });
});

test("keeps unrelated unvalidated pack units in manual review", () => {
  [130, 131, 215, 216].forEach((sourceRow) => {
    const record = catalog.records.find((candidate) => (
      candidate.shopCode === "sc-drug-store" && candidate.sourceRow === sourceRow
    ));
    const match = matchShopeeProduct(record.shopCode, {
      name: record.productName,
      variant: record.variant,
    });
    expect(match).toMatchObject({
      status: "matched",
      isMultipack: true,
      quantityRuleStatus: "requires_validation",
    });
    expect(match).not.toHaveProperty("quantityPerSale");
  });
});

test("keeps the explicit one-unit anchor as an ordinary single-SKU match", () => {
  const record = catalog.records.find((candidate) => (
    candidate.shopCode === "sc-drug-store" && candidate.sourceRow === 67
  ));
  const match = matchShopeeProduct(record.shopCode, {
    name: record.productName,
    variant: record.variant,
  });

  expect(match).toMatchObject({ status: "matched", companySku: "IC-003493" });
  expect(match).not.toHaveProperty("isMultipack");
  expect(match).not.toHaveProperty("quantityPerSale");
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
