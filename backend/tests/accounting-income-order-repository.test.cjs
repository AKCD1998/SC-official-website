const {
  listIncomeOrders,
} = require("../src/modules/seamless/db/accountingIncomeOrderRepository");

test("Income order query is parameterized, Bangkok-date filtered, deduplicated, and paginated", async () => {
  const db = {
    query: jest.fn(async () => ({
      rows: [{
        order_number: "260901TEST001",
        ordered_date: "2026-08-31",
        payout_amount: "125.50",
        total_count: 31,
        transferred_date: "2026-09-01",
      }],
    })),
  };
  const result = await listIncomeOrders({
    dateColumn: "transferredAt",
    dateFrom: "2026-09-01",
    dateTo: "2026-09-07",
    orderNumber: "260901TEST",
    page: 2,
    pageSize: 20,
  }, db);

  expect(result).toEqual({
    orders: [{
      amount: 125.5,
      orderDate: "2026-08-31",
      orderNumber: "260901TEST001",
      transferDate: "2026-09-01",
    }],
    totalCount: 31,
  });
  const [sql, params] = db.query.mock.calls[0];
  expect(sql).toMatch(/PARTITION BY fact\.shop_code, fact\.order_number/iu);
  expect(sql).toMatch(/fact\.transferred_at, fact\.payout_amount/iu);
  expect(sql).toMatch(/AT TIME ZONE 'Asia\/Bangkok'/iu);
  expect(sql).toMatch(/LIMIT \$4 OFFSET \$5/iu);
  expect(sql).not.toContain("260901TEST");
  expect(params).toEqual(["260901TEST", "2026-09-01", "2026-09-07", 20, 20]);
});

test("Income pagination returns the total even when the requested page has no rows", async () => {
  const db = {
    query: jest.fn(async () => ({ rows: [{ total_count: 4, order_number: null }] })),
  };
  await expect(listIncomeOrders({
    dateColumn: "orderedAt",
    dateFrom: null,
    dateTo: null,
    orderNumber: "",
    page: 9,
    pageSize: 20,
  }, db)).resolves.toEqual({ orders: [], totalCount: 4 });
});
