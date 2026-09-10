const listSuccessfulIngestJobsMock = jest.fn();

jest.mock("../db", () => ({ connect: jest.fn() }));
jest.mock("../src/modules/seamless/db/shopeeDocumentSyncStatusRepository", () => ({
  listSuccessfulIngestJobs: (...args) => listSuccessfulIngestJobsMock(...args),
}));

const {
  buildDocumentSyncStatus,
  mondayOfWeek,
} = require("../src/modules/seamless/services/shopeeDocumentSyncStatusService");
const {
  parseDays,
} = require("../src/modules/seamless/controllers/shopeeDocumentSyncStatusController");

const NOW = new Date("2026-09-10T04:30:00.000Z");

function job(overrides = {}) {
  return {
    dateFrom: "2026-09-01",
    dateTo: "2026-09-09",
    importedAt: "2026-09-10T02:05:00.000Z",
    jobId: "20260910090000-business-insights-12345678",
    observedAt: "2026-09-10T02:00:00.000Z",
    reconciliationStatus: "source_backed",
    reportType: "business-insights",
    resultStatus: "imported",
    shopCode: "sc-drug-store",
    sourceFilename: "sales_overview_20260901-20260909.xlsx",
    sourceSha256: "a".repeat(64),
    ...overrides,
  };
}

test("status grid uses yesterday in Bangkok and preserves exact source evidence", () => {
  const result = buildDocumentSyncStatus({
    days: 14,
    jobs: [job()],
    now: NOW,
  });
  expect(result).toMatchObject({
    asOfDate: "2026-09-09",
    startDate: "2026-08-27",
    endDate: "2026-09-09",
    timezone: "Asia/Bangkok",
  });
  const row = result.shops[0].rows.find((item) => item.reportType === "business-insights");
  expect(row).toMatchObject({ expectedCount: 14, ingestedCount: 9, missingCount: 5, status: "incomplete" });
  expect(row.cells[0]).toMatchObject({
    date: "2026-09-09",
    status: "ingested",
    evidence: {
      sourceFilename: "sales_overview_20260901-20260909.xlsx",
      sourceSha256: "a".repeat(64),
    },
  });
});

test("weekly documents are not marked missing before the current week is complete", () => {
  const result = buildDocumentSyncStatus({
    days: 14,
    jobs: [
      job({ reportType: "financial-statement", dateFrom: "2026-08-24", dateTo: "2026-08-30" }),
      job({ reportType: "financial-statement", dateFrom: "2026-08-31", dateTo: "2026-09-06",
        sourceSha256: "b".repeat(64) }),
    ],
    now: NOW,
  });
  const row = result.shops[0].rows.find((item) => item.reportType === "financial-statement");
  expect(row).toMatchObject({ expectedCount: 11, ingestedCount: 11, missingCount: 0, status: "complete" });
  expect(row.cells.filter((cell) => cell.status === "not_due").map((cell) => cell.date))
    .toEqual(["2026-09-09", "2026-09-08", "2026-09-07"]);
});

test("pending income is shown as unavailable until Shopee exposes an export", () => {
  const result = buildDocumentSyncStatus({ days: 14, jobs: [], now: NOW });
  const row = result.shops[0].rows.find((item) => item.reportType === "income-pending");
  expect(row).toMatchObject({ expectedCount: 0, missingCount: 0, status: "unavailable" });
  expect(new Set(row.cells.map((cell) => cell.status))).toEqual(new Set(["unavailable"]));
});

test("date and days validation is deterministic", () => {
  expect(mondayOfWeek("2026-09-10")).toBe("2026-09-07");
  expect(parseDays(undefined)).toBe(14);
  expect(parseDays("31")).toBe(31);
  expect(() => parseDays("30")).toThrow("days must be 14, 31, or 90");
});
