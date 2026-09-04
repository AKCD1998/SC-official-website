const ExcelJS = require("exceljs");
const catalog = require("../src/modules/seamless/data/shopeeProductCatalog.v1.json");
const productAliases = require("../src/modules/seamless/data/shopeeProductAliases.v1.json");
const primaryBarcodeRegistry = require("../src/modules/seamless/data/shopeePrimaryBarcode.v1.json");
const skuUnitValidation = require("../src/modules/seamless/data/shopeeSkuUnitValidation.v1.json");
const {
  collectShopeeCompanySkus,
} = require("../src/modules/seamless/services/erpProductCatalogVerifier");
const {
  matchShopeeProduct,
} = require("../src/modules/seamless/services/shopeeProductMatcher");
const {
  getPrimaryBarcode,
} = require("../src/modules/seamless/services/shopeePrimaryBarcodeRegistry");
const {
  buildShopeeSalesExportFilename,
  buildShopeeSalesExportRows,
  buildShopeeSalesExportWorkbook,
  toBangkokExcelDate,
} = require("../src/modules/seamless/services/shopeeSalesSummaryExportService");

const BASE_ORDER = {
  items: [],
  orderedAt: "2026-09-01T17:05:06.000Z",
  orderNumber: "260902TEST001",
  shopCode: "sc-drug-store",
};

test("exports verified same-SKU multipacks in smallest inventory units", () => {
  const result = buildShopeeSalesExportRows([{
    ...BASE_ORDER,
    items: [{
      name: "Myda Soap",
      productMatch: {
        companySku: "IC-003493",
        isMultipack: true,
        quantityPerSale: 6,
        quantityRuleStatus: "verified",
        quantityUnit: "bar",
        status: "matched",
      },
      quantity: 2,
      variant: "80 กรัม 6 ก้อน",
    }],
  }]);

  expect(result.reviewRows).toEqual([]);
  expect(result.readyRows).toEqual([{
    barcode: "8856513013615",
    companySku: "IC-003493",
    orderNumber: "260902TEST001",
    orderedAt: new Date("2026-09-02T00:05:06.000Z"),
    productName: "Myda Soap — 80 กรัม 6 ก้อน",
    quantity: 12,
    unit: "ก้อน",
  }]);
});

test("splits a verified multi-SKU bundle into one automation row per component", () => {
  const result = buildShopeeSalesExportRows([{
    ...BASE_ORDER,
    items: [{
      name: "Candy Pop คละรส",
      productMatch: {
        components: [
          { companySku: "IC-005598", quantityPerSale: 1 },
          { companySku: "IC-005323", quantityPerSale: 1 },
          { companySku: "IC-005294", quantityPerSale: 1 },
        ],
        quantityRuleStatus: "verified",
        status: "bundle",
      },
      quantity: 2,
      variant: "คละรสละ 1 ซอง",
    }],
  }]);

  expect(result.reviewRows).toEqual([]);
  expect(result.readyRows.map((row) => [row.companySku, row.barcode, row.quantity, row.unit])).toEqual([
    ["IC-005294", "8856513016869", 2, "ซอง"],
    ["IC-005323", "8856513016678", 2, "ซอง"],
    ["IC-005598", "8856513017194", 2, "ซอง"],
  ]);
});

test("exports validated Vita-C packs and keeps unmapped products off the automation sheet", () => {
  const result = buildShopeeSalesExportRows([{
    ...BASE_ORDER,
    items: [
      {
        name: "Vita-C Gummy EXP",
        productMatch: {
          companySku: "IC-001510",
          isMultipack: true,
          quantityPerSale: 24,
          quantityRuleSource: "erp_validated_sku_base_unit",
          quantityRuleStatus: "verified",
          quantityUnit: "sachet",
          status: "matched",
        },
        quantity: 3,
        variant: "24 ซอง",
      },
      {
        name: "ชื่อสินค้าเก่าที่ยังไม่มี alias",
        productMatch: { reasonCode: "catalog_identity_not_found", status: "unmapped" },
        quantity: 1,
        variant: "6 ซอง",
      },
    ],
  }]);

  expect(result.readyRows).toHaveLength(1);
  expect(result.reviewRows).toHaveLength(1);
  const vitaCRow = result.readyRows.find((row) => row.companySku === "IC-001510");
  const unmappedRow = result.reviewRows.find((row) => row.companySku === "-");
  expect(vitaCRow).toMatchObject({
    barcode: "8856513008963",
    companySku: "IC-001510",
    quantity: 72,
    unit: "ซอง",
  });
  expect(unmappedRow).toMatchObject({ barcode: "-", companySku: "-", quantity: 1 });
});

test("combines duplicate rows for the same order and SKU", () => {
  const item = {
    name: "สินค้าทดสอบ",
    productMatch: { companySku: "IC-TEST", status: "matched" },
    quantity: 2,
    variant: "1 กล่อง",
  };
  const result = buildShopeeSalesExportRows([{ ...BASE_ORDER, items: [item, item] }]);

  expect(result.readyRows).toHaveLength(1);
  expect(result.readyRows[0]).toMatchObject({ barcode: "-", quantity: 4, unit: "กล่อง" });
});

test("includes a known primary barcode on rows that still require quantity validation", () => {
  const result = buildShopeeSalesExportRows([{
    ...BASE_ORDER,
    items: [{
      name: "สินค้ารอตรวจตัวคูณ",
      productMatch: {
        companySku: "IC-002353",
        quantityRuleStatus: "requires_validation",
        status: "matched",
      },
      quantity: 1,
      variant: "50 ซอง",
    }],
  }]);

  expect(result.readyRows).toEqual([]);
  expect(result.reviewRows[0]).toMatchObject({
    barcode: "8857121535056",
    companySku: "IC-002353",
    unit: "ชุดขาย (รอตรวจสอบ)",
  });
});

test("exports historical Gummy EXP aliases and corrected Vita-C jars without review rows", () => {
  const alias = productAliases.aliases[0];
  const gummyRecord = catalog.records.find((record) => (
    record.shopCode === alias.shopCode
    && record.productName === alias.canonicalProductName
    && record.variant === "6 ซอง"
  ));
  const jarRecord = catalog.records.find((record) => (
    record.shopCode === "sc-drug-store" && record.sourceRow === 52
  ));
  const result = buildShopeeSalesExportRows([{
    ...BASE_ORDER,
    items: [
      {
        name: alias.aliasProductName,
        productMatch: matchShopeeProduct(alias.shopCode, {
          name: alias.aliasProductName,
          variant: gummyRecord.variant,
        }),
        quantity: 2,
        variant: gummyRecord.variant,
      },
      {
        name: jarRecord.productName,
        productMatch: matchShopeeProduct(jarRecord.shopCode, {
          name: jarRecord.productName,
          variant: jarRecord.variant,
        }),
        quantity: 3,
        variant: jarRecord.variant,
      },
    ],
  }]);

  expect(result.reviewRows).toEqual([]);
  expect(result.readyRows.map((row) => [row.companySku, row.quantity, row.unit])).toEqual([
    ["IC-001510", 12, "ซอง"],
    ["IC-002912", 3, "กระปุก"],
  ]);
});

test("exports owner-confirmed legacy identities with their ERP base units", () => {
  const cases = [
    {
      alias: productAliases.aliases.find((entry) => (
        entry.reasonCode === "seller_title_size_typo_owner_confirmed"
      )),
      quantity: 2,
      variant: "3 กล่อง",
    },
    {
      alias: productAliases.aliases.find((entry) => (
        entry.reasonCode === "historical_shortened_variant_owner_confirmed"
      )),
      quantity: 3,
    },
    {
      alias: productAliases.aliases.find((entry) => (
        entry.reasonCode === "historical_listing_identity_owner_confirmed"
      )),
      quantity: 5,
    },
    {
      alias: productAliases.aliases.find((entry) => (
        entry.reasonCode === "legacy_placeholder_variant_owner_confirmed"
      )),
      quantity: 2,
    },
    {
      alias: productAliases.aliases.find((entry) => (
        entry.reasonCode === "historical_single_box_variant_owner_confirmed"
      )),
      quantity: 2,
    },
    {
      alias: productAliases.aliases.find((entry) => (
        entry.reasonCode === "historical_single_unit_variant_owner_confirmed"
      )),
      quantity: 4,
    },
  ];
  const result = buildShopeeSalesExportRows([{
    ...BASE_ORDER,
    items: cases.map(({ alias, quantity, variant }) => ({
      name: alias.aliasProductName,
      productMatch: matchShopeeProduct(alias.shopCode, {
        name: alias.aliasProductName,
        variant: variant ?? alias.aliasVariant,
      }),
      quantity,
      variant: variant ?? alias.aliasVariant,
    })),
  }]);

  expect(result.reviewRows).toEqual([]);
  expect(result.readyRows.map((row) => [row.companySku, row.quantity, row.unit])).toEqual([
    ["IC-000330", 6, "กล่อง"],
    ["IC-002462", 3, "กระป๋อง"],
    ["IC-005104", 5, "กระป๋อง"],
    ["IC-005370", 2, "กล่อง"],
    ["IC-005371", 20, "ซอง"],
    ["IC-005372", 4, "กล่อง"],
  ]);
});

test("the primary barcode registry covers every Company SKU in the Shopee catalog", () => {
  const catalogSkus = collectShopeeCompanySkus(catalog);
  expect(primaryBarcodeRegistry.records).toHaveLength(catalogSkus.length);
  expect(catalogSkus.every((companySku) => getPrimaryBarcode(companySku))).toBe(true);
  expect(new Set(primaryBarcodeRegistry.records.map((record) => record.primaryBarcode)).size)
    .toBe(primaryBarcodeRegistry.records.length);
});

test("uses StockDay's smallest-unit barcode for every ERP-validated SKU", () => {
  skuUnitValidation.records.forEach((record) => {
    expect(getPrimaryBarcode(record.companySku)).toBe(record.barcodes[0]);
  });
});

test("writes the exact automation columns and a separate review worksheet", async () => {
  const { buffer, readyRowCount, reviewRowCount } = await buildShopeeSalesExportWorkbook([{
    ...BASE_ORDER,
    items: [
      {
        name: "สินค้าพร้อมคีย์",
        productMatch: { companySku: "IC-003493", status: "matched" },
        quantity: 2,
        variant: "1 กล่อง",
      },
      {
        name: "สินค้ารอตรวจ",
        productMatch: { status: "unmapped" },
        quantity: 1,
        variant: "",
      },
    ],
  }]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  expect(readyRowCount).toBe(1);
  expect(reviewRowCount).toBe(1);
  expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["พร้อมคีย์", "ต้องตรวจสอบ"]);
  expect(workbook.getWorksheet("พร้อมคีย์").getRow(1).values.slice(1)).toEqual([
    "วันที่ เวลา",
    "เลขออเดอร์",
    "เลข SKU บริษัท",
    "เลขบาร์โค้ด",
    "ชื่อสินค้า",
    "จำนวนสินค้า (หน่วยที่เล็กสุด)",
    "หน่วย",
  ]);
  expect(workbook.getWorksheet("พร้อมคีย์").getCell("A2").numFmt)
    .toBe("yyyy-mm-dd hh:mm:ss");
  expect(workbook.getWorksheet("พร้อมคีย์").getCell("D2").value)
    .toBe("8856513013615");
  expect(workbook.getWorksheet("พร้อมคีย์").getCell("D2").numFmt)
    .toBe("@");
  expect(workbook.getWorksheet("ต้องตรวจสอบ").getCell("H1").value)
    .toBe("เหตุผลที่ต้องตรวจสอบ");
});

test("formats Bangkok wall-clock timestamps and deterministic filenames", () => {
  expect(toBangkokExcelDate("2026-09-01T17:05:06.000Z").toISOString())
    .toBe("2026-09-02T00:05:06.000Z");
  expect(buildShopeeSalesExportFilename({
    endDate: "2026-09-03",
    shopCode: "sc-drug-store",
    startDate: "2026-09-01",
  })).toBe("shopee-sales-sc-drug-store-2026-09-01-to-2026-09-03.xlsx");
});
