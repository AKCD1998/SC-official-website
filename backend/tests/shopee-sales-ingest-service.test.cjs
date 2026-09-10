const crypto = require("node:crypto");
const ExcelJS = require("exceljs");
const { HEADERS } = require("../src/modules/seamless/services/shopeeSalesSourceService");
const { HEADERS: CONFIRMED_HEADERS, SHEET: CONFIRMED_SHEET } = require("../src/modules/seamless/services/shopeeConfirmedSalesService");
const { BALANCE_HEADERS } = require("../src/modules/seamless/services/shopeeOfficialDocumentService");

let mockAuditRow = null;
const mockQueries = [];
const mockClient = {
  release: jest.fn(),
  query: jest.fn(async (sql, params = []) => {
    mockQueries.push({ sql, params });
    if (/SELECT \* FROM .*shopee_sales_ingest_jobs/iu.test(sql)) {
      return { rows: mockAuditRow ? [mockAuditRow] : [] };
    }
    if (/SELECT \* FROM .*shopee_sales_sources/iu.test(sql)) return { rows: [] };
    if (/SELECT f\.order_number/iu.test(sql)) return { rows: [] };
    if (/INSERT INTO .*shopee_sales_ingest_jobs/iu.test(sql)) {
      mockAuditRow = {
        job_id: params[0], shop_code: params[1], report_type: params[2],
        source_sha256: params[3], source_filename: params[4], observed_at: new Date(params[5]),
        date_from: params[6], date_to: params[7], result_status: params[8],
        source_row_count: params[9], reconciliation_status: params[10],
        response_metadata: JSON.parse(params[11]), imported_at: new Date("2026-09-09T02:01:00.000Z"),
      };
      return { rows: [mockAuditRow] };
    }
    return { rows: [] };
  }),
};

jest.mock("../db", () => ({ connect: jest.fn(async () => mockClient) }));

const {
  ingestShopeeSalesSource,
  multipartFilenameMatches,
  validateUpload,
} = require("../src/modules/seamless/services/shopeeSalesIngestService");

test("accepts only the lossless multipart latin1 view of an exact Thai Shopee filename", () => {
  const originalFilename = "Income.โอนเงินสำเร็จ.th.20260824_20260830.xlsx";
  const multipartFilename = Buffer.from(originalFilename, "utf8").toString("latin1");
  expect(multipartFilenameMatches(multipartFilename, originalFilename)).toBe(true);
  expect(multipartFilenameMatches("Income.รอดำเนินการ.th.20260824_20260830.xlsx", originalFilename)).toBe(false);
  const buffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]);
  expect(() => validateUpload({
    buffer,
    size: buffer.length,
    originalname: multipartFilename,
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }, {
    reportType: "income-transferred",
    originalFilename,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
  })).not.toThrow();
});

async function source() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("orders");
  sheet.addRow(Object.values(HEADERS));
  sheet.addRow(["TESTORDER001", "สำเร็จแล้ว", "2026-09-08 12:00", "สินค้าทดสอบ", "หนึ่งกล่อง", 1, 100, 90, 5, 10]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  return {
    body: {
      shopCode: "sc-drug-store",
      reportType: "orders",
      dateFrom: "2026-09-08",
      dateTo: "2026-09-08",
      originalFilename: "Order.all.20260908_20260908.xlsx",
      observedAt: "2026-09-09T02:00:00.000Z",
      sha256,
      jobId: "20260909090000-orders-12345678",
    },
    file: {
      buffer,
      size: buffer.length,
      originalname: "Order.all.20260908_20260908.xlsx",
      mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  };
}

async function confirmedSource() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(CONFIRMED_SHEET);
  sheet.addRow(Object.values(CONFIRMED_HEADERS));
  sheet.addRow(["08-09-2026-08-09-2026", 125.5, 2, 1, 25.5, 0, 0]);
  sheet.addRow([]);
  sheet.addRow(Object.values(CONFIRMED_HEADERS));
  sheet.addRow(["08-09-2026", 125.5, 2, 1, 25.5, 0, 0]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const originalFilename = "142wuxqhgi.shopee-shop-stats.20260908-20260908.xlsx";
  return {
    body: { shopCode: "sc-drug-store", reportType: "business-insights",
      dateFrom: "2026-09-08", dateTo: "2026-09-08", originalFilename,
      observedAt: "2026-09-09T02:00:00.000Z", sha256,
      jobId: "20260909091500-business-insights-12345678" },
    file: { buffer, size: buffer.length, originalname: originalFilename,
      mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  };
}

async function sellerBalanceSource() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Transaction Report");
  sheet.getCell("A6").value = "ชื่อผู้ใช้ของผู้ขาย";
  sheet.getCell("B6").value = "142wuxqhgi";
  sheet.getCell("B7").value = "2026-09-01";
  sheet.getCell("B8").value = "2026-09-06";
  sheet.getCell("E12").value = 100;
  sheet.getCell("G12").value = 1;
  sheet.getCell("E13").value = 0;
  sheet.getCell("G13").value = 0;
  sheet.getRow(18).values = Object.values(BALANCE_HEADERS);
  sheet.getRow(19).values = [
    "2026-09-02 10:00", "รายรับจากคำสั่งซื้อ", "เงินจากคำสั่งซื้อ",
    "260901TEST001", "เงินเข้า", 100, "ทำรายการสำเร็จ", 1000,
  ];
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const originalFilename = "my_balance_transaction_report.shopee.20260901_20260906.xlsx";
  return {
    body: {
      shopCode: "sc-drug-store", reportType: "seller-balance",
      dateFrom: "2026-09-01", dateTo: "2026-09-06", originalFilename,
      observedAt: "2026-09-09T02:00:00.000Z", sha256,
      jobId: "20260909091500-seller-balance-12345678",
    },
    file: {
      buffer, size: buffer.length, originalname: originalFilename,
      mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  };
}

beforeEach(() => {
  mockAuditRow = null;
  mockQueries.length = 0;
  mockClient.query.mockClear();
  mockClient.release.mockClear();
});

test("source import and ingest audit commit atomically, then exact replay is unchanged", async () => {
  const input = await source();
  const imported = await ingestShopeeSalesSource(input);
  expect(imported).toMatchObject({ status: "imported", shopCode: "sc-drug-store", reportType: "orders" });
  expect(mockQueries[0].sql).toBe("BEGIN");
  expect(mockQueries.some(({ sql }) => /INSERT INTO .*shopee_sales_sources/iu.test(sql))).toBe(true);
  expect(mockQueries.some(({ sql }) => /INSERT INTO .*shopee_sales_ingest_jobs/iu.test(sql))).toBe(true);
  expect(mockQueries.at(-1).sql).toBe("COMMIT");

  mockQueries.length = 0;
  const replay = await ingestShopeeSalesSource(input);
  expect(replay.status).toBe("unchanged");
  expect(mockQueries.some(({ sql }) => /INSERT INTO .*shopee_sales_sources/iu.test(sql))).toBe(false);
  expect(mockQueries.at(-1).sql).toBe("COMMIT");
});

test("same job ID with different immutable metadata rolls back with HTTP 409", async () => {
  const input = await source();
  await ingestShopeeSalesSource(input);
  mockQueries.length = 0;
  await expect(ingestShopeeSalesSource({
    ...input,
    body: { ...input.body, observedAt: "2026-09-09T02:02:00.000Z" },
  })).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });
  expect(mockQueries.at(-1).sql).toBe("ROLLBACK");
});

test("confirmed Business Insights import returns complete coverage and shares the audit transaction", async () => {
  const imported = await ingestShopeeSalesSource(await confirmedSource());
  expect(imported).toMatchObject({ status: "imported", reportType: "business-insights",
    coverage: { coveredDays: 1, expectedDays: 1 }, reconciliationStatus: "source_backed" });
  expect(mockQueries.some(({ sql }) => /INSERT INTO .*shopee_confirmed_sources/iu.test(sql))).toBe(true);
  expect(mockQueries.some(({ sql }) => /INSERT INTO .*shopee_sales_ingest_jobs/iu.test(sql))).toBe(true);
  expect(mockQueries.at(-1).sql).toBe("COMMIT");
});

test("official finance source validates, imports privacy-safe facts and records full period coverage", async () => {
  const imported = await ingestShopeeSalesSource(await sellerBalanceSource());
  expect(imported).toMatchObject({
    status: "imported",
    reportType: "seller-balance",
    coverage: { coveredDays: 6, expectedDays: 6 },
    reconciliationStatus: "document_validated",
  });
  expect(mockQueries.some(({ sql }) => /INSERT INTO .*shopee_official_document_sources/iu.test(sql))).toBe(true);
  expect(mockQueries.some(({ sql }) => /INSERT INTO .*shopee_seller_balance_facts/iu.test(sql))).toBe(true);
  expect(mockQueries.at(-1).sql).toBe("COMMIT");
});

test("hash mismatch and parser rejection stop before any database connection", async () => {
  const input = await source();
  await expect(ingestShopeeSalesSource({
    ...input,
    body: { ...input.body, sha256: "0".repeat(64) },
  })).rejects.toMatchObject({ statusCode: 400 });
  expect(mockClient.query).not.toHaveBeenCalled();

  const wrongSheet = Buffer.from(input.file.buffer);
  const wrong = {
    ...input,
    body: { ...input.body, sha256: crypto.createHash("sha256").update(wrongSheet).digest("hex") },
    file: { ...input.file, buffer: wrongSheet, size: wrongSheet.length },
  };
  // Declaring the Orders bytes as Business Insights makes the exact sheet/filename contract fail.
  wrong.body.reportType = "business-insights";
  wrong.body.originalFilename = "142wuxqhgi.shopee-shop-stats.20260908-20260908.xlsx";
  wrong.file.originalname = wrong.body.originalFilename;
  await expect(ingestShopeeSalesSource(wrong)).rejects.toMatchObject({
    statusCode: 422,
    code: "SHOPEE_SOURCE_REJECTED",
  });
  expect(mockClient.query).not.toHaveBeenCalled();
});
