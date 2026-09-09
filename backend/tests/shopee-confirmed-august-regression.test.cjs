const {
  HEADERS,
  parseConfirmedSalesRows,
  summarizeConfirmedSales,
} = require("../src/modules/seamless/services/shopeeConfirmedSalesService");

const AUGUST = { startDate: "2026-08-01", endDate: "2026-08-31" };

function reportRows({ salesFirst30, salesLast, ordersFirst30, ordersLast,
  cancelledFirst30, cancelledLast, cancelledOrdersLast = 1 }) {
  const daily = Array.from({ length: 31 }, (_, index) => {
    const day = index + 1;
    return [
      `${String(day).padStart(2, "0")}-08-2026`,
      day === 31 ? salesLast : salesFirst30,
      day === 31 ? ordersLast : ordersFirst30,
      day === 31 ? cancelledOrdersLast : 0,
      day === 31 ? cancelledLast : cancelledFirst30,
      0,
      0,
    ];
  });
  const total = column => daily.reduce((sum, row) => sum + Number(row[column]), 0);
  return [
    Object.values(HEADERS),
    ["01-08-2026-31-08-2026", total(1), total(2), total(3), total(4), total(5), total(6)],
    [],
    Object.values(HEADERS),
    ...daily,
  ];
}

function parseShop(shopCode, username, values) {
  return parseConfirmedSalesRows(reportRows(values), {
    shopCode,
    sourceFilename: `${username}.shopee-shop-stats.20260801-20260831.xlsx`,
    sourceSha256: shopCode === "sc-drug-store" ? "a".repeat(64) : "b".repeat(64),
    observedAt: "2026-09-08T00:00:00+07:00",
  });
}

test("August confirmed regression keeps both official shop totals and cancellations separate", () => {
  const sc = parseShop("sc-drug-store", "142wuxqhgi", {
    salesFirst30: 4900, salesLast: 7026,
    ordersFirst30: 19, ordersLast: 43,
    cancelledFirst30: 200, cancelledLast: 1478,
  });
  const dr = parseShop("dr-morepen", "mu3f314od9", {
    salesFirst30: 500, salesLast: 2891,
    ordersFirst30: 1, ordersLast: 6,
    cancelledFirst30: 10, cancelledLast: 50,
  });
  const summary = summarizeConfirmedSales([...sc.facts, ...dr.facts], {
    shopCode: "all",
    ...AUGUST,
  });
  expect(summary).toMatchObject({
    status: "source_backed",
    salesTotal: 171917,
    orderCount: 649,
    cancelledSales: 7828,
    coveredDays: 62,
    expectedDays: 62,
  });
  expect(summary.shops).toEqual([
    expect.objectContaining({ shopCode: "sc-drug-store", salesTotal: 154026,
      orderCount: 613, cancelledSales: 7478 }),
    expect.objectContaining({ shopCode: "dr-morepen", salesTotal: 17891,
      orderCount: 36, cancelledSales: 350 }),
  ]);
});

test("arbitrary inclusive ranges resolve from the same confirmed daily facts", () => {
  const sc = parseShop("sc-drug-store", "142wuxqhgi", {
    salesFirst30: 4900, salesLast: 7026,
    ordersFirst30: 19, ordersLast: 43,
    cancelledFirst30: 200, cancelledLast: 1478,
  });
  expect(summarizeConfirmedSales(sc.facts.slice(14, 16), {
    shopCode: "sc-drug-store", startDate: "2026-08-15", endDate: "2026-08-16",
  })).toMatchObject({ salesTotal: 9800, orderCount: 38, cancelledSales: 400,
    coveredDays: 2, expectedDays: 2 });
  expect(summarizeConfirmedSales(sc.facts.slice(30), {
    shopCode: "sc-drug-store", startDate: "2026-08-31", endDate: "2026-08-31",
  })).toMatchObject({ salesTotal: 7026, orderCount: 43, cancelledSales: 1478,
    coveredDays: 1, expectedDays: 1 });
});
