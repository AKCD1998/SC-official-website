const listFinanceSourcesMock = jest.fn();
const listReconciliationFactsMock = jest.fn();

jest.mock("../db", () => ({ connect: jest.fn() }));
jest.mock("../src/modules/seamless/db/shopeeOfficialDocumentRepository", () => ({
  listFinanceSources: (...args) => listFinanceSourcesMock(...args),
  listReconciliationFacts: (...args) => listReconciliationFactsMock(...args),
}));

const {
  sameMultiset,
  summarizeFinance,
  summarizeReturns,
} = require("../src/modules/seamless/services/shopeeOfficialDocumentSummaryService");

const PERIOD_SOURCE = {
  shop_code: "sc-drug-store",
  source_filename: "source",
  observed_at: new Date("2026-09-09T02:00:00.000Z"),
  start_date: "2026-08-31",
  end_date: "2026-09-06",
  source_row_count: 1,
};

beforeEach(() => jest.clearAllMocks());

test("weekly finance is source-backed only when totals and nonzero order evidence match", async () => {
  listFinanceSourcesMock.mockResolvedValue([
    { ...PERIOD_SOURCE, report_type: "financial-statement", source_sha256: "a".repeat(64),
      control: { transferredTotal: 100 } },
    { ...PERIOD_SOURCE, report_type: "income-transferred", source_sha256: "b".repeat(64),
      source_row_count: 2, control: { transferredTotal: 100, orderCount: 2 } },
    { ...PERIOD_SOURCE, report_type: "seller-balance", source_sha256: "c".repeat(64),
      control: { orderTotal: 100, orderCount: 1, adjustmentTotal: -30, adjustmentCount: 1 } },
  ]);
  listReconciliationFactsMock.mockImplementation(async ({ reportType }) => (
    reportType === "income-transferred"
      ? [{ order_number: "ORDER1", payout_amount: "100.00" }, { order_number: "ORDERZERO", payout_amount: "0.00" }]
      : [{ order_number: "ORDER1", amount: "100.00" }]
  ));
  const result = await summarizeFinance({}, {
    shopCode: "sc-drug-store", startDate: "2026-08-31", endDate: "2026-09-06",
  });
  expect(result[0]).toMatchObject({
    status: "source_backed",
    statementTotal: 100,
    incomeTransferredTotal: 100,
    incomeTransferredOrderCount: 2,
    zeroPayoutOrderCount: 1,
    sellerBalanceOrderTotal: 100,
    sellerBalanceOrderCount: 1,
    sellerBalanceAdjustmentTotal: -30,
    totalsMatch: true,
    orderEvidenceMatches: true,
  });
});

test("weekly finance reports incomplete and mismatch independently", async () => {
  listFinanceSourcesMock.mockResolvedValueOnce([
    { ...PERIOD_SOURCE, report_type: "financial-statement", source_sha256: "a".repeat(64),
      control: { transferredTotal: 100 } },
  ]);
  await expect(summarizeFinance({}, {
    shopCode: "sc-drug-store", startDate: "2026-08-31", endDate: "2026-09-06",
  })).resolves.toEqual([expect.objectContaining({
    status: "incomplete",
    missingReportTypes: ["income-transferred", "seller-balance"],
  })]);

  listFinanceSourcesMock.mockResolvedValueOnce([
    { ...PERIOD_SOURCE, report_type: "financial-statement", source_sha256: "a".repeat(64),
      control: { transferredTotal: 100 } },
    { ...PERIOD_SOURCE, report_type: "income-transferred", source_sha256: "b".repeat(64),
      control: { transferredTotal: 90, orderCount: 1 } },
    { ...PERIOD_SOURCE, report_type: "seller-balance", source_sha256: "c".repeat(64),
      control: { orderTotal: 90, orderCount: 1 } },
  ]);
  listReconciliationFactsMock.mockResolvedValue([{ order_number: "ORDER1", payout_amount: 90, amount: 90 }]);
  await expect(summarizeFinance({}, {
    shopCode: "sc-drug-store", startDate: "2026-08-31", endDate: "2026-09-06",
  })).resolves.toEqual([expect.objectContaining({ status: "mismatch", totalsMatch: false })]);
});

test("exception summary uses order-created coverage and exact Shopee amount meanings", () => {
  const result = summarizeReturns({
    sources: [{
      shop_code: "sc-drug-store",
      source_filename: "Order.return_refund_cancel.20260901_20260907.zip",
      observed_at: "2026-09-09T02:00:00.000Z",
      start_date: "2026-09-01",
      end_date: "2026-09-06",
    }],
    facts: [
      { shop_code: "sc-drug-store", event_type: "cancelled", amount: 120 },
      { shop_code: "sc-drug-store", event_type: "return_refund", amount: 75 },
    ],
  }, { shopCode: "sc-drug-store", startDate: "2026-09-01", endDate: "2026-09-08" });
  expect(result[0]).toMatchObject({
    status: "incomplete",
    coveredDayCount: 6,
    expectedDayCount: 8,
    missingDates: ["2026-09-07", "2026-09-08"],
    cancelledOrderCount: 1,
    cancelledNetSales: 120,
    returnRefundRequestCount: 1,
    totalRefundAmount: 75,
  });
});

test("order/amount comparison is a multiset, not only a total", () => {
  expect(sameMultiset(["A:5000", "B:5000"], ["A:5000", "B:5000"])).toBe(true);
  expect(sameMultiset(["A:5000", "B:5000"], ["A:6000", "B:4000"])).toBe(false);
});
