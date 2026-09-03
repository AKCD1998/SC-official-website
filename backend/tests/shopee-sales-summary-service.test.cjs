const listOrdersForSalesSummaryMock = jest.fn();
const catalog = require("../src/modules/seamless/data/shopeeProductCatalog.v1.json");

jest.mock("../src/modules/seamless/db/shopeeOrderRepository", () => ({
  listOrdersForSalesSummary: (...args) => listOrdersForSalesSummaryMock(...args),
}));

const {
  getShopeeSalesSummary,
  summarizeSalesByProduct,
} = require("../src/modules/seamless/services/shopeeSalesSummaryService");
const {
  matchShopeeProduct,
} = require("../src/modules/seamless/services/shopeeProductMatcher");

const BASE_ORDER = {
  currentStatus: "shipment_due",
  itemSubtotal: 120,
  items: [],
  orderedAt: "2026-09-01T01:00:00.000Z",
  orderNumber: "260901TEST001",
  shopCode: "sc-drug-store",
};

beforeEach(() => {
  jest.clearAllMocks();
});

test("groups the same product and variant while preserving per-order drilldown", () => {
  const summary = summarizeSalesByProduct([
    {
      ...BASE_ORDER,
      items: [
        {
          name: "สินค้าทดสอบ",
          productMatch: { companySku: "IC-001", status: "matched" },
          quantity: 2,
          variant: "30 เม็ด",
        },
        {
          name: " สินค้าทดสอบ ",
          productMatch: { companySku: "IC-001", status: "matched" },
          quantity: 1,
          variant: "30  เม็ด",
        },
      ],
    },
    {
      ...BASE_ORDER,
      itemSubtotal: 99.5,
      orderedAt: "2026-09-01T03:00:00.000Z",
      orderNumber: "260901TEST002",
      shopCode: "dr-morepen",
      items: [{ name: "สินค้าทดสอบ", quantity: 4, variant: "30 เม็ด" }],
    },
  ]);

  expect(summary).toMatchObject({ orderCount: 2, productCount: 1, totalQuantity: 7 });
  expect(summary.products[0]).toMatchObject({
    companySkus: ["IC-001"],
    name: "สินค้าทดสอบ",
    orderCount: 2,
    totalQuantity: 7,
    variant: "30 เม็ด",
  });
  expect(summary.products[0].orders).toEqual([
    {
      itemSubtotal: 99.5,
      orderNumber: "260901TEST002",
      orderedAt: "2026-09-01T03:00:00.000Z",
      quantity: 4,
      shopCode: "dr-morepen",
    },
    {
      itemSubtotal: 120,
      orderNumber: "260901TEST001",
      orderedAt: "2026-09-01T01:00:00.000Z",
      quantity: 3,
      shopCode: "sc-drug-store",
    },
  ]);
});

test("keeps variants separate, sorts by quantity, and ignores non-positive lines", () => {
  const summary = summarizeSalesByProduct([{
    ...BASE_ORDER,
    items: [
      { name: "สินค้า A", quantity: 1, variant: "ใหญ่" },
      { name: "สินค้า A", quantity: 3, variant: "เล็ก" },
      { name: "สินค้า B", quantity: 0, variant: "" },
    ],
  }]);

  expect(summary.products.map((product) => [product.name, product.variant, product.totalQuantity]))
    .toEqual([
      ["สินค้า A", "เล็ก", 3],
      ["สินค้า A", "ใหญ่", 1],
    ]);
});

test("expands verified bundle quantities into inventory units for totals and drilldown", () => {
  const summary = summarizeSalesByProduct([{
    ...BASE_ORDER,
    items: [{
      name: "Gluco One BG-03 Test Strip",
      productMatch: {
        status: "bundle",
        quantityRuleStatus: "verified",
        components: [{ companySku: "IC-003478", quantityPerSale: 3 }],
      },
      quantity: 2,
      variant: "แผ่นตรวจ 25 3 กล่อง",
    }],
    shopCode: "dr-morepen",
  }]);

  expect(summary).toMatchObject({ orderCount: 1, productCount: 1, totalQuantity: 6 });
  expect(summary.products[0]).toMatchObject({
    companySkus: ["IC-003478"],
    isBundle: true,
    quantityRuleStatus: "verified",
    totalQuantity: 6,
    unitsPerSale: 3,
  });
  expect(summary.products[0].orders).toEqual([{
    isBundle: true,
    itemSubtotal: 120,
    listingQuantity: 2,
    orderNumber: BASE_ORDER.orderNumber,
    orderedAt: BASE_ORDER.orderedAt,
    quantity: 6,
    quantityRuleStatus: "verified",
    shopCode: "dr-morepen",
    unitsPerSale: 3,
  }]);
});

test("expands automatically inferred same-SKU multipacks for historical orders", () => {
  const record = catalog.records.find((candidate) => (
    candidate.shopCode === "sc-drug-store" && candidate.sourceRow === 154
  ));
  const summary = summarizeSalesByProduct([{
    ...BASE_ORDER,
    items: [{
      name: record.productName,
      productMatch: matchShopeeProduct(record.shopCode, {
        name: record.productName,
        variant: record.variant,
      }),
      quantity: 2,
      variant: record.variant,
    }],
  }]);

  expect(summary).toMatchObject({ orderCount: 1, productCount: 1, totalQuantity: 12 });
  expect(summary.products[0]).toMatchObject({
    companySkus: ["IC-003493"],
    isBundle: true,
    quantityRuleStatus: "verified",
    totalQuantity: 12,
    unitsPerSale: 6,
  });
  expect(summary.products[0].orders[0]).toMatchObject({
    listingQuantity: 2,
    quantity: 12,
    unitsPerSale: 6,
  });
});

test("leaves an unanchored same-SKU pack unexpanded and marks it for validation", () => {
  const record = catalog.records.find((candidate) => (
    candidate.shopCode === "sc-drug-store" && candidate.sourceRow === 148
  ));
  const summary = summarizeSalesByProduct([{
    ...BASE_ORDER,
    items: [{
      name: record.productName,
      productMatch: matchShopeeProduct(record.shopCode, {
        name: record.productName,
        variant: record.variant,
      }),
      quantity: 2,
      variant: record.variant,
    }],
  }]);

  expect(summary).toMatchObject({ totalQuantity: 2 });
  expect(summary.products[0]).toMatchObject({
    isBundle: true,
    quantityRuleStatus: "requires_validation",
    totalQuantity: 2,
  });
  expect(summary.products[0]).not.toHaveProperty("unitsPerSale");
});

test("marks an unverified bundle without inventing an inventory multiplier", () => {
  const summary = summarizeSalesByProduct([{
    ...BASE_ORDER,
    items: [{
      name: "ชุดสินค้าที่ยังไม่ยืนยันจำนวน",
      productMatch: {
        status: "bundle",
        quantityRuleStatus: "requires_validation",
        components: [{ companySku: "IC-TEST" }],
      },
      quantity: 1,
      variant: "3 กล่อง",
    }],
  }]);

  expect(summary).toMatchObject({ orderCount: 1, productCount: 1, totalQuantity: 1 });
  expect(summary.products[0]).toMatchObject({
    companySkus: ["IC-TEST"],
    isBundle: true,
    quantityRuleStatus: "requires_validation",
    totalQuantity: 1,
  });
  expect(summary.products[0]).not.toHaveProperty("unitsPerSale");
  expect(summary.products[0].orders[0]).toMatchObject({
    isBundle: true,
    listingQuantity: 1,
    quantity: 1,
    quantityRuleStatus: "requires_validation",
  });
  expect(summary.products[0].orders[0]).not.toHaveProperty("unitsPerSale");
});

test("loads only the requested shop and date range before summarizing", async () => {
  listOrdersForSalesSummaryMock.mockResolvedValueOnce([{ ...BASE_ORDER, items: [] }]);

  await expect(getShopeeSalesSummary({
    endDate: "2026-09-03",
    shopCode: "all",
    startDate: "2026-09-01",
  })).resolves.toMatchObject({ productCount: 0, totalQuantity: 0 });
  expect(listOrdersForSalesSummaryMock).toHaveBeenCalledWith({
    endDate: "2026-09-03",
    shopCode: "all",
    startDate: "2026-09-01",
  });
});
