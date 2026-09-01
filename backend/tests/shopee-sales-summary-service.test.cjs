const listOrdersForSalesSummaryMock = jest.fn();

jest.mock("../src/modules/seamless/db/shopeeOrderRepository", () => ({
  listOrdersForSalesSummary: (...args) => listOrdersForSalesSummaryMock(...args),
}));

const {
  getShopeeSalesSummary,
  summarizeSalesByProduct,
} = require("../src/modules/seamless/services/shopeeSalesSummaryService");

const BASE_ORDER = {
  currentStatus: "shipment_due",
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
      orderNumber: "260901TEST002",
      orderedAt: "2026-09-01T03:00:00.000Z",
      quantity: 4,
      shopCode: "dr-morepen",
    },
    {
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
