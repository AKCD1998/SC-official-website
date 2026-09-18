const {
  SELLER_BALANCE_STATUSES,
  deriveSellerBalanceStatus,
  listIncomeExportSourceDocuments,
  listIncomeOrders,
} = require("../src/modules/seamless/db/accountingIncomeOrderRepository");

test.each([
  {
    expected: SELLER_BALANCE_STATUSES.OUTFLOW_OR_REVERSED,
    input: {
      covered: true,
      hasSuccessfulOutflow: true,
      incomeAmount: "125.50",
      successfulInflowAmount: "125.50",
      successfulInflowCount: 1,
    },
    label: "successful outflow takes precedence over an exact inflow",
  },
  {
    expected: SELLER_BALANCE_STATUSES.CREDITED,
    input: {
      covered: true,
      hasSuccessfulOutflow: false,
      incomeAmount: "125.50",
      successfulInflowAmount: "125.50",
      successfulInflowCount: 1,
    },
    label: "exact successful inflow is credited",
  },
  {
    expected: SELLER_BALANCE_STATUSES.AMOUNT_MISMATCH,
    input: {
      covered: true,
      hasSuccessfulOutflow: false,
      incomeAmount: "125.50",
      successfulInflowAmount: "120.00",
      successfulInflowCount: 1,
    },
    label: "successful inflow with a different amount needs review",
  },
  {
    expected: SELLER_BALANCE_STATUSES.NOT_FOUND_IN_COVERED_REPORT,
    input: {
      covered: true,
      hasSuccessfulOutflow: false,
      incomeAmount: "125.50",
      successfulInflowAmount: 0,
      successfulInflowCount: 0,
    },
    label: "a covering report with no evidence is distinguished from missing coverage",
  },
  {
    expected: SELLER_BALANCE_STATUSES.NOT_COVERED,
    input: {
      covered: false,
      hasSuccessfulOutflow: false,
      incomeAmount: "125.50",
      successfulInflowAmount: 0,
      successfulInflowCount: 0,
    },
    label: "missing report coverage is not called unpaid",
  },
])("derives Seller Balance status: $label", ({ expected, input }) => {
  expect(deriveSellerBalanceStatus(input)).toBe(expected);
});

test("Income order query is parameterized, Bangkok-date filtered, deduplicated, and paginated", async () => {
  const db = {
    query: jest.fn(async () => ({
      rows: [{
        order_number: "260901TEST001",
        ordered_date: "2026-08-31",
        payout_amount: "125.50",
        seller_balance_covered: true,
        seller_balance_inflow_date: "2026-09-01",
        shop_code: "sc-drug-store",
        successful_inflow_amount: "125.50",
        successful_inflow_count: 1,
        successful_net_amount: "125.50",
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
    shopCode: "sc-drug-store",
  }, db);

  expect(result).toEqual({
    orders: [{
      amount: 125.5,
      orderDate: "2026-08-31",
      orderNumber: "260901TEST001",
      sellerBalanceNetAmount: 125.5,
      sellerBalanceStatus: "credited",
      sellerBalanceInflowDate: "2026-09-01",
      shopCode: "sc-drug-store",
      transferDate: "2026-09-01",
    }],
    totalCount: 31,
  });
  const [sql, params] = db.query.mock.calls[0];
  expect(sql).toMatch(/PARTITION BY fact\.shop_code, fact\.order_number/iu);
  expect(sql).toMatch(/fact\.transferred_at, fact\.payout_amount/iu);
  expect(sql).toMatch(/FROM page_order_keys page_key[\s\S]*JOIN .*shopee_seller_balance_facts/iu);
  expect(sql).toMatch(/PARTITION BY balance\.shop_code, balance\.order_number,[\s\S]*balance\.balance_after/iu);
  expect(sql).toMatch(/balance\.transaction_type = 'รายรับจากคำสั่งซื้อ'/u);
  expect(sql).toMatch(/status = 'ทำรายการสำเร็จ' AND direction = 'เงินออก'/u);
  expect(sql).toMatch(/MAX\(transaction_at\) FILTER \([\s\S]*status = 'ทำรายการสำเร็จ' AND direction = 'เงินเข้า'[\s\S]*latest_successful_inflow_at/iu);
  expect(sql).toMatch(/coverage_source\.report_type = 'seller-balance'/u);
  expect(sql).toMatch(/page_rows\.transferred_at AT TIME ZONE 'Asia\/Bangkok'/u);
  expect(sql).toMatch(/AT TIME ZONE 'Asia\/Bangkok'/iu);
  expect(sql).toMatch(/fact\.shop_code = \$2/iu);
  expect(sql).toMatch(/LIMIT \$5 OFFSET \$6/iu);
  expect(sql).not.toContain("260901TEST");
  expect(params).toEqual([
    "260901TEST",
    "sc-drug-store",
    "2026-09-01",
    "2026-09-07",
    20,
    20,
  ]);
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

test.each([
  [false, "not_covered"],
  [true, "not_found_in_covered_report"],
])("Income row with no successful Balance evidence keeps amount/date null (covered=%s)", async (
  sellerBalanceCovered,
  sellerBalanceStatus,
) => {
  const db = {
    query: jest.fn(async () => ({
      rows: [{
        ordered_date: "2026-08-31",
        order_number: "260901TEST003",
        payout_amount: "125.50",
        seller_balance_covered: sellerBalanceCovered,
        total_count: 1,
        transferred_date: "2026-09-01",
      }],
    })),
  };

  const result = await listIncomeOrders({
    dateColumn: "transferredAt",
    dateFrom: null,
    dateTo: null,
    orderNumber: "",
    page: 1,
    pageSize: 10,
  }, db);

  expect(result.orders[0]).toMatchObject({
    sellerBalanceNetAmount: null,
    sellerBalanceStatus,
    sellerBalanceInflowDate: null,
  });
});

test("Income rows expose shop identity, reversal precedence, and privacy-safe Seller Balance evidence", async () => {
  const db = {
    query: jest.fn(async () => ({
      rows: [{
        has_successful_outflow: true,
        ordered_date: "2026-08-31",
        order_number: "260901TEST002",
        payout_amount: "125.50",
        seller_balance_covered: true,
        seller_balance_inflow_date: "2026-09-01",
        shop_code: "sc-drug-store",
        successful_inflow_amount: "125.50",
        successful_inflow_count: 1,
        successful_net_amount: "0.00",
        total_count: 1,
        transferred_date: "2026-09-01",
      }],
    })),
  };
  const result = await listIncomeOrders({
    dateColumn: "transferredAt",
    dateFrom: null,
    dateTo: null,
    orderNumber: "",
    page: 1,
    pageSize: 10,
  }, db);

  expect(result.orders).toEqual([{
    amount: 125.5,
    orderDate: "2026-08-31",
    orderNumber: "260901TEST002",
    sellerBalanceNetAmount: 0,
    sellerBalanceStatus: "outflow_or_reversed",
    sellerBalanceInflowDate: "2026-09-01",
    shopCode: "sc-drug-store",
    transferDate: "2026-09-01",
  }]);
  expect(result.orders[0]).not.toHaveProperty("buyerUsername");
});

test("Income export source documents prefer stored originals and retain canonical-only evidence", async () => {
  const checksumStored = "a".repeat(64);
  const checksumCanonicalOnly = "b".repeat(64);
  const db = {
    query: jest.fn()
      .mockResolvedValueOnce({
        rows: [{
          batch_id: "batch-1",
          item_id: "item-1",
          document: {
            checksumSha256: checksumStored,
            end: "2026-08-31",
            filename: "Income.โอนเงินสำเร็จ.th.20260801_20260831.xlsx",
            kind: "income",
            shopCode: "sc-drug-store",
            start: "2026-08-01",
          },
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          end_date: "2026-08-31",
          report_type: "income-transferred",
          shop_code: "sc-drug-store",
          source_filename: "Income.โอนเงินสำเร็จ.th.20260801_20260831.xlsx",
          source_sha256: checksumStored,
          start_date: "2026-08-01",
        }, {
          end_date: "2026-08-31",
          report_type: "financial-statement",
          shop_code: "dr-morepen",
          source_filename: "weekly_report_20260801.pdf",
          source_sha256: checksumCanonicalOnly,
          start_date: "2026-08-01",
        }],
      }),
  };

  const result = await listIncomeExportSourceDocuments({
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
  }, db);

  expect(result).toEqual([{
    checksumSha256: checksumCanonicalOnly,
    endDate: "2026-08-31",
    filename: "weekly_report_20260801.pdf",
    kind: "statement",
    originalAvailable: false,
    originalPath: null,
    shopCode: "dr-morepen",
    startDate: "2026-08-01",
  }, {
    checksumSha256: checksumStored,
    endDate: "2026-08-31",
    filename: "Income.โอนเงินสำเร็จ.th.20260801_20260831.xlsx",
    kind: "income",
    originalAvailable: true,
    originalPath: "/app/accounting-print-bundles/batch-1/items/item-1/original",
    shopCode: "sc-drug-store",
    startDate: "2026-08-01",
  }]);
  expect(db.query).toHaveBeenCalledTimes(2);
  expect(db.query.mock.calls[0][1]).toEqual(["2026-08-01", "2026-08-31"]);
  expect(db.query.mock.calls[0][0]).toMatch(/accounting_print_items/iu);
  expect(db.query.mock.calls[1][0]).toMatch(/shopee_official_document_sources/iu);
});

test("Income export source documents apply the selected shop to stored and canonical evidence", async () => {
  const db = {
    query: jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }),
  };

  await listIncomeExportSourceDocuments({
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
    shopCode: "dr-morepen",
  }, db);

  expect(db.query.mock.calls[0][0]).toMatch(/document->>'shopCode' = \$3/iu);
  expect(db.query.mock.calls[1][0]).toMatch(/shop_code = \$3/iu);
  expect(db.query.mock.calls[0][1]).toEqual(["2026-08-01", "2026-08-31", "dr-morepen"]);
  expect(db.query.mock.calls[1][1]).toEqual(["2026-08-01", "2026-08-31", "dr-morepen"]);
});
