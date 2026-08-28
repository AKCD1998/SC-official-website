const catalog = require("../src/modules/seamless/data/shopeeProductCatalog.v1.json");
const {
  checksumRecords,
  collectShopeeCompanySkus,
  verifyShopeeCatalogAgainstErp,
} = require("../src/modules/seamless/services/erpProductCatalogVerifier");

function responseBody(companySkus) {
  const records = companySkus.map((companySku) => ({
    barcodes: [],
    companySku,
    displayName: `Product ${companySku}`,
    productKind: null,
    updatedAt: null,
  }));
  return {
    schemaVersion: 1,
    source: "sc-erp-product-master",
    sourceChecksum: checksumRecords(records),
    requestedCount: companySkus.length,
    resolvedCount: records.length,
    missingCompanySkus: [],
    records,
  };
}

test("collects unique Company SKUs from single products and bundle components", () => {
  const companySkus = collectShopeeCompanySkus(catalog);
  expect(companySkus.length).toBeGreaterThan(100);
  expect(companySkus).toContain("IC-003230");
  expect(companySkus).toContain("IC-003478");
  expect(companySkus).toEqual([...companySkus].sort((a, b) => a.localeCompare(b, "en")));
});

test("verifies the complete Shopee catalog through the bounded read-only contract", async () => {
  let request;
  const result = await verifyShopeeCatalogAgainstErp({
    catalog,
    internalToken: "test-token",
    resolveUrl: "https://erp.example/internal/product-catalog/resolve",
    fetchImpl: async (url, options) => {
      request = { url, options };
      const companySkus = JSON.parse(options.body).companySkus;
      return { ok: true, status: 200, json: async () => responseBody(companySkus) };
    },
  });

  expect(request.url).toBe("https://erp.example/internal/product-catalog/resolve");
  expect(request.options.headers["x-internal-token"]).toBe("test-token");
  expect(result).toMatchObject({
    catalogVersion: catalog.catalogVersion,
    checkedCompanySkuCount: collectShopeeCompanySkus(catalog).length,
    resolvedCompanySkuCount: collectShopeeCompanySkus(catalog).length,
  });
});

test("fails closed on missing SKUs, checksum drift, non-HTTPS URLs, and HTTP failures", async () => {
  const companySkus = collectShopeeCompanySkus(catalog);
  const missingBody = responseBody(companySkus);
  missingBody.records = missingBody.records.slice(1);
  missingBody.missingCompanySkus = [companySkus[0]];
  missingBody.resolvedCount = missingBody.records.length;
  missingBody.sourceChecksum = checksumRecords(missingBody.records);

  await expect(verifyShopeeCatalogAgainstErp({
    catalog,
    internalToken: "test-token",
    resolveUrl: "https://erp.example/resolve",
    fetchImpl: async () => ({ ok: true, json: async () => missingBody }),
  })).rejects.toMatchObject({ code: "ERP_SKUS_MISSING" });

  const invalidChecksum = responseBody(companySkus);
  invalidChecksum.sourceChecksum = "0".repeat(64);
  await expect(verifyShopeeCatalogAgainstErp({
    catalog,
    internalToken: "test-token",
    resolveUrl: "https://erp.example/resolve",
    fetchImpl: async () => ({ ok: true, json: async () => invalidChecksum }),
  })).rejects.toThrow("checksum validation failed");

  await expect(verifyShopeeCatalogAgainstErp({
    catalog,
    internalToken: "test-token",
    resolveUrl: "http://erp.example/resolve",
  })).rejects.toThrow("must use HTTPS");

  await expect(verifyShopeeCatalogAgainstErp({
    catalog,
    internalToken: "test-token",
    resolveUrl: "https://erp.example/resolve",
    fetchImpl: async () => ({ ok: false, status: 503 }),
  })).rejects.toThrow("HTTP 503");
});
