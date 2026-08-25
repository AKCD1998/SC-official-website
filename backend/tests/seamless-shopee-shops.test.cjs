const { findSourceUploadByChecksum } = require("../src/modules/seamless/db/generatedFileRepository");
const {
  getShopeeShopProfile,
  normalizeShopeeShopCode,
  requireShopeeShopCode,
} = require("../src/modules/seamless/services/shopeeShops");

test("normalizes supported Shopee shop aliases to stable audit codes", () => {
  expect(normalizeShopeeShopCode("SC_DRUG_STORE")).toBe("sc-drug-store");
  expect(normalizeShopeeShopCode("drmorepen")).toBe("dr-morepen");
  expect(getShopeeShopProfile("dr-morepen")).toEqual(
    expect.objectContaining({ displayName: "DR.Morepen", outputSlug: "dr-morepen" }),
  );
});

test("Shopee shop selection fails closed when missing or unsupported", () => {
  expect(() => requireShopeeShopCode("")).toThrow("กรุณาเลือกร้าน Shopee");
  expect(() => requireShopeeShopCode("unknown-shop")).toThrow("ร้าน Shopee ที่เลือกไม่รองรับ");
});

test("source duplicate lookup scopes Shopee checks by shop and treats legacy rows as DR.Morepen", async () => {
  const client = {
    query: jest.fn().mockResolvedValue({ rows: [] }),
  };
  const checksum = "a".repeat(64);

  await findSourceUploadByChecksum(
    checksum,
    { requestedVariant: "shopee", shopCode: "sc-drug-store" },
    client,
  );

  const [sql, params] = client.query.mock.calls[0];
  expect(sql).toContain("gf.metadata ->> 'shopCode'");
  expect(sql).toContain("'dr-morepen'");
  expect(params).toEqual([checksum, "shopee", "sc-drug-store"]);
});
