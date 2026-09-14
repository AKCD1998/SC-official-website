const crypto = require("node:crypto");
const ExcelJS = require("exceljs");
const XLSX = require("xlsx");
const { zipSync } = require("fflate");
const { HEADERS } = require("../src/modules/seamless/services/shopeeSalesSourceService");
const { HEADERS: CONFIRMED_HEADERS, SHEET: CONFIRMED_SHEET } = require("../src/modules/seamless/services/shopeeConfirmedSalesService");
const { BALANCE_HEADERS } = require("../src/modules/seamless/services/shopeeOfficialDocumentService");
const {
  CANCELLED_HEADERS,
  FAILED_DELIVERY_HEADERS,
  RETURN_HEADERS,
} = require("../src/modules/seamless/services/shopeeReturnSourceService");

let mockAuditRow = null;
let mockSalesSourceRows = [];
const mockQueries = [];
const mockClient = {
  release: jest.fn(),
  query: jest.fn(async (sql, params = []) => {
    mockQueries.push({ sql, params });
    if (/SELECT \* FROM .*shopee_sales_ingest_jobs/iu.test(sql)) {
      return { rows: mockAuditRow?.job_id === params[0] ? [mockAuditRow] : [] };
    }
    if (/SELECT \* FROM .*shopee_sales_sources/iu.test(sql)) return { rows: mockSalesSourceRows };
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
  parseManifest,
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

test("accepts Shopee's 22-byte empty exceptional-case ZIP but not an empty XLSX", () => {
  const buffer = Buffer.alloc(22);
  buffer.writeUInt32LE(0x06054b50, 0);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const file = {
    buffer,
    size: buffer.length,
    originalname: "Order.return_refund_cancel.20260901_20260909.zip",
    mimetype: "application/zip",
  };
  expect(() => validateUpload(file, {
    reportType: "return-refund-cancel",
    originalFilename: file.originalname,
    sha256,
  })).not.toThrow();
  expect(() => validateUpload({
    ...file,
    originalname: "142wuxqhgi.shopee-shop-stats.20260901-20260908.xlsx",
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }, {
    reportType: "business-insights",
    originalFilename: "142wuxqhgi.shopee-shop-stats.20260901-20260908.xlsx",
    sha256,
  })).toThrow(/XLSX ZIP magic/iu);
});

async function source() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("orders");
  sheet.addRow(Object.values(HEADERS));
  sheet.addRow(["TESTORDER001", "สำเร็จแล้ว", "2026-09-08 12:00", "2026-09-08 12:01",
    "สินค้าทดสอบ", "หนึ่งกล่อง", 1, 100, 90, 5, 10, "-", "2026-09-08 18:00"]);
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

async function returnCarryOverSource() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("orders");
  sheet.addRow(Object.values(CANCELLED_HEADERS));
  sheet.addRow([
    "260911TEST001", "ยกเลิกแล้ว", "2026-09-11 21:19", 120,
    "ยกเลิกโดยอัตโนมัติจากระบบของ Shopee", "-",
  ]);
  const entry = Buffer.from(await workbook.xlsx.writeBuffer());
  const buffer = Buffer.from(zipSync({
    "Order.cancelled.20260912_20260913_part_1_of_1.xlsx": new Uint8Array(entry),
  }));
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const originalFilename = "Order.return_refund_cancel.20260912_20260913.zip";
  return {
    body: {
      shopCode: "sc-drug-store", reportType: "return-refund-cancel",
      dateFrom: "2026-09-12", dateTo: "2026-09-12", originalFilename,
      observedAt: "2026-09-13T09:12:44.149Z", sha256,
      jobId: "20260913090448-return-refund-cancel-c8a38c6d",
    },
    file: {
      buffer, size: buffer.length, originalname: originalFilename,
      mimetype: "application/zip",
    },
  };
}

async function xlsxWithHeaders(headers) {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("orders").addRow(Object.values(headers));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function assembledReturnSource() {
  const files = [
    {
      kind: "cancelled", extension: "xlsx", part: 1, totalParts: 1,
      originalFilename: "Order.cancelled.20260912_20260913_part_1_of_1.xlsx",
      buffer: await xlsxWithHeaders(CANCELLED_HEADERS),
    },
    {
      kind: "return_refund", extension: "xls", part: 1, totalParts: 1,
      originalFilename: "Order.return_refund.20260912_20260913_part_1_of_1.xls",
      buffer: Buffer.from(XLSX.write({
        SheetNames: ["orders"],
        Sheets: { orders: XLSX.utils.aoa_to_sheet([Object.values(RETURN_HEADERS)]) },
      }, { type: "buffer", bookType: "xls" })),
    },
    {
      kind: "failed_delivery", extension: "xlsx", part: 1, totalParts: 1,
      originalFilename: "Order.failed_delivery.20260912_20260913_part_1_of_1.xlsx",
      buffer: await xlsxWithHeaders(FAILED_DELIVERY_HEADERS),
    },
  ].map((item) => ({
    ...item,
    bytes: item.buffer.length,
    sha256: crypto.createHash("sha256").update(item.buffer).digest("hex"),
  }));
  const buffer = Buffer.from(zipSync(Object.fromEntries(files.map((item) => [
    item.originalFilename, new Uint8Array(item.buffer),
  ])), { level: 0 }));
  const archiveFilename = "assembled.Order.return_refund_cancel.20260912_20260913.zip";
  return {
    body: {
      shopCode: "sc-drug-store",
      reportType: "return-refund-cancel",
      dateFrom: "2026-09-12",
      dateTo: "2026-09-12",
      assembledFromOfficialComponents: "true",
      archiveFilename,
      // Deliberately shuffled: the backend must canonicalize before audit storage.
      sourceOriginalFiles: JSON.stringify([files[2], files[0], files[1]].map(({ buffer: ignored, ...item }) => item)),
      observedAt: "2026-09-13T09:12:44.149Z",
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      jobId: "20260913090448-return-refund-cancel-assembled",
    },
    file: { buffer, size: buffer.length, originalname: archiveFilename, mimetype: "application/zip" },
    files,
  };
}

beforeEach(() => {
  mockAuditRow = null;
  mockSalesSourceRows = [];
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

test("a new job ID can safely backfill same-SHA order timestamps without breaking job replay idempotency", async () => {
  const input = await source();
  mockSalesSourceRows = [{
    shop_code: input.body.shopCode,
    source_filename: input.body.originalFilename,
    observed_at: new Date(input.body.observedAt),
    order_count: 1,
  }];
  const result = await ingestShopeeSalesSource({
    ...input,
    body: { ...input.body, jobId: "20260910120000-orders-backfill-12345678" },
  });
  expect(result.status).toBe("unchanged");
  expect(mockQueries.some(({ sql }) => /INSERT INTO .*shopee_sales_sources/iu.test(sql))).toBe(false);
  expect(mockQueries.some(({ sql }) => /UPDATE .*shopee_sales_order_facts/iu.test(sql))).toBe(true);
  expect(mockQueries.some(({ sql }) => /INSERT INTO .*shopee_sales_ingest_jobs/iu.test(sql))).toBe(true);

  mockQueries.length = 0;
  await ingestShopeeSalesSource({
    ...input,
    body: { ...input.body, jobId: "20260910120000-orders-backfill-12345678" },
  });
  expect(mockQueries.some(({ sql }) => /UPDATE|INSERT INTO .*shopee_sales_sources/iu.test(sql))).toBe(false);
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

test("official exceptional-case ingest accepts an order created before its lifecycle report day", async () => {
  const imported = await ingestShopeeSalesSource(await returnCarryOverSource());
  expect(imported).toMatchObject({
    status: "imported",
    reportType: "return-refund-cancel",
    coverage: { coveredDays: 1, expectedDays: 1 },
    reconciliationStatus: "document_validated",
  });
  expect(imported.assembledProvenance).toBeUndefined();
  expect(mockQueries.some(({ sql }) => /INSERT INTO .*shopee_return_facts/iu.test(sql))).toBe(true);
  expect(mockQueries.some(({ sql }) => /INSERT INTO .*shopee_sales_ingest_jobs/iu.test(sql))).toBe(true);
  expect(mockQueries.at(-1).sql).toBe("COMMIT");
});

test("assembled exceptional-case ingest verifies components, returns sanitized provenance and replays unchanged", async () => {
  const input = await assembledReturnSource();
  const imported = await ingestShopeeSalesSource(input);
  expect(imported).toMatchObject({
    status: "imported",
    sourceFilename: input.body.archiveFilename,
    assembledProvenance: {
      assembledFromOfficialComponents: true,
      archiveFilename: input.body.archiveFilename,
      sourceFilename: input.body.archiveFilename,
    },
  });
  expect(imported.assembledProvenance.sourceOriginalFiles.map((item) => item.kind))
    .toEqual(["cancelled", "return_refund", "failed_delivery"]);
  expect(imported.assembledProvenance.sourceOriginalFiles.every((item) => (
    Object.keys(item).sort().join(",")
      === "bytes,extension,kind,originalFilename,part,sha256,totalParts"
  ))).toBe(true);
  expect(JSON.stringify(imported.assembledProvenance)).not.toMatch(/[\\/](?:Users|AppData|documents)[\\/]/iu);

  mockQueries.length = 0;
  const reorderObject = (value) => Object.fromEntries(Object.entries(value).reverse());
  const storedProvenance = mockAuditRow.response_metadata.assembledProvenance;
  mockAuditRow.response_metadata.assembledProvenance = reorderObject({
    ...storedProvenance,
    sourceOriginalFiles: storedProvenance.sourceOriginalFiles.map(reorderObject),
  });
  const replayBody = {
    ...input.body,
    sourceOriginalFiles: JSON.stringify(JSON.parse(input.body.sourceOriginalFiles).reverse()),
  };
  const replay = await ingestShopeeSalesSource({ ...input, body: replayBody });
  expect(replay.status).toBe("unchanged");
  expect(replay.assembledProvenance).toEqual(imported.assembledProvenance);
  expect(mockQueries.some(({ sql }) => /INSERT INTO .*shopee_official_document_sources/iu.test(sql))).toBe(false);
  expect(mockQueries.at(-1).sql).toBe("COMMIT");
});

test("direct manifest cannot disguise an assembled archive without component provenance", async () => {
  const input = await assembledReturnSource();
  await expect(ingestShopeeSalesSource({
    body: {
      shopCode: input.body.shopCode,
      reportType: input.body.reportType,
      dateFrom: input.body.dateFrom,
      dateTo: input.body.dateTo,
      originalFilename: input.body.archiveFilename,
      observedAt: input.body.observedAt,
      sha256: input.body.sha256,
      jobId: "20260913090448-return-refund-cancel-direct-bypass",
    },
    file: input.file,
  })).rejects.toMatchObject({ statusCode: 422, code: "SHOPEE_SOURCE_REJECTED" });
  expect(mockClient.query).not.toHaveBeenCalled();
});

test("assembled upload requires multipart filename to equal archiveFilename", async () => {
  const input = await assembledReturnSource();
  const manifest = parseManifest(input.body);
  expect(() => validateUpload({ ...input.file, originalname: "other.zip" }, manifest))
    .toThrow(/does not match archiveFilename/iu);
});

test("assembled manifest rejects incomplete, ambiguous, local-path and incorrectly ranged provenance", async () => {
  const input = await assembledReturnSource();
  const files = JSON.parse(input.body.sourceOriginalFiles);
  const withSources = (sourceOriginalFiles, extra = {}) => ({
    ...input.body,
    ...extra,
    sourceOriginalFiles: typeof sourceOriginalFiles === "string"
      ? sourceOriginalFiles : JSON.stringify(sourceOriginalFiles),
  });
  const cancelled = files.find((item) => item.kind === "cancelled");
  const returnRefund = files.find((item) => item.kind === "return_refund");
  expect(() => parseManifest(withSources([
    { ...cancelled, totalParts: 2,
      originalFilename: cancelled.originalFilename.replace("part_1_of_1", "part_1_of_2") },
    { ...cancelled, part: 2, totalParts: 2,
      originalFilename: cancelled.originalFilename.replace("part_1_of_1", "part_2_of_2") },
    returnRefund,
  ])))
    .toThrow(/missing failed_delivery/iu);
  expect(() => parseManifest(withSources([...files, { ...files[0] }])))
    .toThrow(/incomplete or duplicated|duplicate/iu);
  expect(() => parseManifest(withSources(files.map((item, index) => index === 0
    ? { ...item, storedFilename: "C:\\private\\file.xlsx" } : item))))
    .toThrow(/unsupported or missing fields/iu);
  expect(() => parseManifest(withSources(files.map((item) => item.kind === "return_refund"
    ? { ...item, extension: "xlsx", originalFilename: item.originalFilename.replace(/\.xls$/u, ".xlsx") } : item))))
    .toThrow(/unsupported component format/iu);
  expect(() => parseManifest(withSources(files.map((item, index) => index === 0
    ? { ...item, originalFilename: item.originalFilename.replace("20260913", "20260914") } : item))))
    .toThrow(/does not match the manifest/iu);
  expect(() => parseManifest(withSources(files, { archiveFilename: "assembled.Order.return_refund_cancel.20260912_20260914.zip" })))
    .toThrow(/archiveFilename does not match/iu);
  expect(() => parseManifest(withSources(files, { originalFilename: input.body.archiveFilename })))
    .toThrow(/unsupported fields|must not fabricate/iu);
  expect(() => parseManifest({
    ...input.body,
    assembledFromOfficialComponents: undefined,
    archiveFilename: undefined,
    sourceOriginalFiles: undefined,
    originalFilename: "Order.return_refund_cancel.20260912_20260913.zip",
    sourcePath: "C:\\private\\evidence.zip",
  })).toThrow(/unsupported fields/iu);
  expect(() => parseManifest(withSources("[" + " ".repeat(33 * 1024) + "]")))
    .toThrow(/malformed or exceeds/iu);
});

test("assembled archive rejects extra, missing, hash and byte-length member evidence before database access", async () => {
  const input = await assembledReturnSource();
  const declared = JSON.parse(input.body.sourceOriginalFiles);
  const zipEntries = Object.fromEntries(input.files.map((item) => [item.originalFilename, new Uint8Array(item.buffer)]));
  const corruptReturnBytes = Buffer.from([1, 2, 3, 4]);
  const corruptReturnProvenance = declared.map((item) => item.kind === "return_refund" ? {
    ...item,
    bytes: corruptReturnBytes.length,
    sha256: crypto.createHash("sha256").update(corruptReturnBytes).digest("hex"),
  } : item);
  const corruptReturnEntries = { ...zipEntries };
  corruptReturnEntries[corruptReturnProvenance.find((item) => item.kind === "return_refund").originalFilename]
    = new Uint8Array(corruptReturnBytes);
  const variants = [
    {
      body: input.body,
      buffer: Buffer.from(zipSync({ ...zipEntries, "extra.xlsx": new Uint8Array([1]) }, { level: 0 })),
    },
    {
      body: input.body,
      buffer: Buffer.from(zipSync(Object.fromEntries(Object.entries(zipEntries).slice(0, 2)), { level: 0 })),
    },
    {
      body: { ...input.body, sourceOriginalFiles: JSON.stringify(declared.map((item, index) => (
        index === 0 ? { ...item, sha256: "0".repeat(64) } : item
      ))) },
      buffer: input.file.buffer,
    },
    {
      body: { ...input.body, sourceOriginalFiles: JSON.stringify(declared.map((item, index) => (
        index === 0 ? { ...item, bytes: item.bytes + 1 } : item
      ))) },
      buffer: input.file.buffer,
    },
    {
      body: { ...input.body, sourceOriginalFiles: JSON.stringify(corruptReturnProvenance) },
      buffer: Buffer.from(zipSync(corruptReturnEntries, { level: 0 })),
    },
  ];
  for (const variant of variants) {
    const sha256 = crypto.createHash("sha256").update(variant.buffer).digest("hex");
    await expect(ingestShopeeSalesSource({
      body: { ...variant.body, sha256 },
      file: { ...input.file, buffer: variant.buffer, size: variant.buffer.length },
    })).rejects.toMatchObject({ statusCode: 422, code: "SHOPEE_SOURCE_REJECTED" });
  }
  expect(mockClient.query).not.toHaveBeenCalled();
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
