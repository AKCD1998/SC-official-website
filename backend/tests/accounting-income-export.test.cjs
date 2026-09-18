const ExcelJS = require("exceljs");
const { PDFDocument } = require("pdf-lib");
const {
  EXPORT_PAGE_SIZE,
  buildAccountingIncomeExportFilename,
  buildAccountingIncomeExportPreview,
  buildAccountingIncomeExportWorkbook,
  collectAllIncomeOrders,
  exportAccountingIncomeOrders,
  exportAccountingIncomeOrdersBundle,
  exportAccountingIncomeOrdersPdf,
  isFullCalendarMonth,
  selectAccountingSourceDocuments,
} = require("../src/modules/seamless/services/accountingIncomeExportService");

const filters = Object.freeze({
  dateColumn: "transferredAt",
  dateFrom: "2026-08-01",
  dateTo: "2026-08-31",
  orderNumber: "",
});

function exampleOrders() {
  return [{
    amount: 125.5,
    orderDate: "2026-07-30",
    orderNumber: "260730TEST001",
    sellerBalanceInflowDate: "2026-08-02",
    sellerBalanceNetAmount: 125.5,
    sellerBalanceStatus: "credited",
    shopCode: "sc-drug-store",
    transferDate: "2026-08-01",
  }, {
    amount: 90,
    orderDate: "2026-08-03",
    orderNumber: "260803TEST002",
    sellerBalanceInflowDate: null,
    sellerBalanceNetAmount: null,
    sellerBalanceStatus: "not_covered",
    shopCode: "sc-drug-store",
    transferDate: "2026-08-05",
  }];
}

function exampleDocuments() {
  return [{
    checksumSha256: "a".repeat(64),
    endDate: "2026-08-02",
    filename: "weekly_report_20260727.pdf",
    kind: "statement",
    originalAvailable: true,
    originalPath: "/app/accounting-print-bundles/batch-1/items/statement-1/original",
    periodType: "weekly",
    shopCode: "sc-drug-store",
    sourceFile: { storageProvider: "r2", storagePath: "weekly.pdf", storageBucket: "docs" },
    startDate: "2026-07-27",
  }, {
    checksumSha256: "b".repeat(64),
    endDate: "2026-08-07",
    filename: "Income.โอนเงินสำเร็จ.th.20260801_20260807.xlsx",
    kind: "income",
    originalAvailable: false,
    originalPath: null,
    periodType: "income",
    shopCode: "sc-drug-store",
    startDate: "2026-08-01",
  }];
}

async function exampleOriginalPdf() {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 500]);
  pdf.addPage([500, 400]);
  return Buffer.from(await pdf.save());
}

test("accounting Income workbook explains transferred-date scope and links original Shopee evidence", async () => {
  const buffer = await buildAccountingIncomeExportWorkbook({
    documents: exampleDocuments(),
    filters,
    orders: exampleOrders(),
    publicOrigin: "https://api.example.test",
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
    "เอกสารต้นฉบับ",
    "รายการรายรับ",
  ]);
  const sources = workbook.getWorksheet("เอกสารต้นฉบับ");
  expect(sources.getCell("A2").value).toBe("ชุดข้อมูลรายรับสำหรับบัญชี");
  expect(sources.getCell("B5").value).toBe("วันที่โอนชำระเงินสำเร็จ");
  expect(sources.getCell("B6").value).toContain("ไม่ใช่วันที่สั่งซื้อ");
  expect(sources.getCell("B11").value).toBe(2);
  expect(sources.getCell("D11").value).toBe(215.5);
  expect(sources.getCell("F11").value).toBe(1);
  expect(sources.getCell("A16").value).toBe("รายงานการเงิน (รายสัปดาห์)");
  expect(sources.getCell("G16").value).toEqual({
    hyperlink: "https://api.example.test/api/app/accounting-print-bundles/batch-1/items/statement-1/original",
    text: "เปิดดูต้นฉบับ",
  });
  expect(sources.getCell("F17").value).toBe("มีข้อมูลอ้างอิง แต่ยังไม่มีไฟล์ต้นฉบับ");

  const orders = workbook.getWorksheet("รายการรายรับ");
  expect(orders.getCell("A2").value).toContain("01/08/2026 ถึง 31/08/2026");
  expect(orders.getCell("A4").value).toBe("หมายเลขคำสั่งซื้อ");
  expect(orders.getCell("B4").value).toBe("ร้าน");
  expect(orders.getCell("D4").value).toBe("วันที่โอนชำระเงินสำเร็จ");
  expect(orders.getCell("A5").value).toBe("260730TEST001");
  expect(orders.getCell("B5").value).toBe("SC Drug Store");
  expect(orders.getCell("E5").value).toBe(125.5);
  expect(orders.getCell("F5").value).toBe("เงินเข้าแล้ว");
  expect(orders.getCell("F5").fill.fgColor.argb).toBe("FFC6EFCE");
  expect(orders.getCell("F5").font.color.argb).toBe("FF006100");
  expect(orders.getCell("F6").fill.fgColor.argb).toBe("FFDDEBF7");
  expect(orders.getCell("F6").font.color.argb).toBe("FF44546A");
  expect(orders.getCell("H6").value).toBeNull();
  expect(orders.autoFilter.toString()).toContain("A4:H6");
});

test("accounting preview uses the same filters, totals, rows, and source evidence as the workbook", () => {
  const preview = buildAccountingIncomeExportPreview({
    documents: exampleDocuments(),
    filters: { ...filters, shopCode: "sc-drug-store" },
    orders: exampleOrders(),
    publicOrigin: "https://api.example.test",
  });

  expect(preview.filters.shopLabel).toBe("SC Drug Store");
  expect(preview.summary).toEqual({
    availableOriginalCount: 1,
    creditedCount: 1,
    missingOriginalCount: 1,
    orderCount: 2,
    totalIncome: 215.5,
  });
  expect(preview.orders[0]).toMatchObject({
    orderNumber: "260730TEST001",
    shopCode: "sc-drug-store",
  });
  expect(preview.documents[0]).toMatchObject({
    kindLabel: "รายงานการเงิน (รายสัปดาห์)",
    originalUrl: "https://api.example.test/api/app/accounting-print-bundles/batch-1/items/statement-1/original",
    shopLabel: "SC Drug Store",
  });
});

test("full calendar month selects one exact monthly statement plus every overlapping boundary week", () => {
  const statement = (periodType, startDate, endDate, originalAvailable = true) => ({
    checksumSha256: `${periodType}-${startDate}`,
    endDate,
    filename: `${periodType}_report_${startDate.replaceAll("-", "")}.pdf`,
    kind: "statement",
    originalAvailable,
    originalPath: originalAvailable ? "/original" : null,
    periodType,
    shopCode: "sc-drug-store",
    startDate,
  });
  const documents = [
    statement("monthly", "2026-08-01", "2026-08-31"),
    statement("weekly", "2026-07-27", "2026-08-02"),
    statement("weekly", "2026-08-03", "2026-08-09"),
    statement("weekly", "2026-08-10", "2026-08-16"),
    statement("weekly", "2026-08-17", "2026-08-23"),
    statement("weekly", "2026-08-24", "2026-08-30"),
    statement("weekly", "2026-08-31", "2026-09-06", false),
  ];
  const selected = selectAccountingSourceDocuments(documents, {
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
    shopCode: "sc-drug-store",
  });

  expect(isFullCalendarMonth("2026-08-01", "2026-08-31")).toBe(true);
  expect(selected.filter((document) => document.periodType === "monthly")).toHaveLength(1);
  expect(selected.filter((document) => document.periodType === "weekly")).toHaveLength(6);
  expect(selected[1]).toMatchObject({ startDate: "2026-07-27", endDate: "2026-08-02" });
  expect(selected[6]).toMatchObject({ startDate: "2026-08-31", endDate: "2026-09-06" });
});

test("partial month excludes monthly statements and reports missing weekly originals without inventing files", () => {
  const selected = selectAccountingSourceDocuments([{
    checksumSha256: "monthly",
    endDate: "2026-08-31",
    filename: "monthly_report_20260801.pdf",
    kind: "statement",
    originalAvailable: true,
    periodType: "monthly",
    shopCode: "sc-drug-store",
    startDate: "2026-08-01",
  }], {
    dateFrom: "2026-08-05",
    dateTo: "2026-08-12",
    shopCode: "sc-drug-store",
  });

  expect(isFullCalendarMonth("2026-08-05", "2026-08-12")).toBe(false);
  expect(selected).toHaveLength(2);
  expect(selected.every((document) => document.periodType === "weekly")).toBe(true);
  expect(selected.every((document) => document.isRequiredPlaceholder)).toBe(true);
});

test("ZIP bundle contains the generated workbook, available originals, and a missing-file manifest", async () => {
  const { unzipSync, strFromU8 } = require("fflate");
  const incomeRepository = {
    listIncomeExportSourceDocuments: jest.fn().mockResolvedValue(exampleDocuments()),
    listIncomeOrders: jest.fn().mockResolvedValue({ orders: exampleOrders(), totalCount: 2 }),
  };
  const storage = {
    readStoredFile: jest.fn().mockResolvedValue(await exampleOriginalPdf()),
  };
  const bundle = await exportAccountingIncomeOrdersBundle({
    ...filters,
    shopCode: "sc-drug-store",
  }, { incomeRepository, publicOrigin: "https://api.example.test", storage });
  const entries = unzipSync(new Uint8Array(bundle.buffer));
  const names = Object.keys(entries);

  expect(bundle.filename).toMatch(/\.zip$/u);
  expect(names.some((name) => name.endsWith(".xlsx"))).toBe(true);
  expect(names.some((name) => name.endsWith("with-shopee-appendix.pdf"))).toBe(true);
  expect(names.some((name) => name.endsWith("weekly_report_20260727.pdf"))).toBe(true);
  expect(strFromU8(entries["README.txt"])).toContain("ไฟล์ต้นฉบับที่ยังขาด");
});

test("combined PDF keeps the generated report first and appends every original Shopee PDF page", async () => {
  const originalPdf = await exampleOriginalPdf();
  const incomeRepository = {
    listIncomeExportSourceDocuments: jest.fn().mockResolvedValue(exampleDocuments()),
    listIncomeOrders: jest.fn().mockResolvedValue({ orders: exampleOrders(), totalCount: 2 }),
  };
  const storage = {
    readStoredFile: jest.fn().mockResolvedValue(originalPdf),
  };

  const exported = await exportAccountingIncomeOrdersPdf({
    ...filters,
    shopCode: "sc-drug-store",
  }, { incomeRepository, publicOrigin: "https://api.example.test", storage });
  const combined = await PDFDocument.load(exported.buffer);

  expect(exported.mimeType).toBe("application/pdf");
  expect(exported.filename).toMatch(/with-shopee-appendix\.pdf$/u);
  expect(combined.getPageCount()).toBe(5);
  expect(combined.getPage(3).getSize()).toEqual({ width: 400, height: 500 });
  expect(combined.getPage(4).getSize()).toEqual({ width: 500, height: 400 });
  expect(storage.readStoredFile).toHaveBeenCalledTimes(1);
});

test("collectAllIncomeOrders requests every page without exposing pagination in the export", async () => {
  const firstPageOrders = Array.from({ length: EXPORT_PAGE_SIZE }, (_, index) => ({
    orderNumber: `ORDER${index}`,
  }));
  const incomeRepository = {
    listIncomeOrders: jest.fn()
      .mockResolvedValueOnce({ orders: firstPageOrders, totalCount: EXPORT_PAGE_SIZE + 1 })
      .mockResolvedValueOnce({ orders: [{ orderNumber: "ORDER-LAST" }], totalCount: EXPORT_PAGE_SIZE + 1 }),
  };

  const orders = await collectAllIncomeOrders(filters, incomeRepository);

  expect(orders).toHaveLength(EXPORT_PAGE_SIZE + 1);
  expect(incomeRepository.listIncomeOrders).toHaveBeenNthCalledWith(1, {
    ...filters,
    page: 1,
    pageSize: EXPORT_PAGE_SIZE,
  });
  expect(incomeRepository.listIncomeOrders).toHaveBeenNthCalledWith(2, {
    ...filters,
    page: 2,
    pageSize: EXPORT_PAGE_SIZE,
  });
});

test("exportAccountingIncomeOrders returns a stable range filename and fetches source documents", async () => {
  const incomeRepository = {
    listIncomeExportSourceDocuments: jest.fn().mockResolvedValue(exampleDocuments()),
    listIncomeOrders: jest.fn().mockResolvedValue({ orders: exampleOrders(), totalCount: 2 }),
  };

  const exported = await exportAccountingIncomeOrders(filters, {
    incomeRepository,
    publicOrigin: "https://api.example.test",
  });

  expect(exported.filename).toBe(buildAccountingIncomeExportFilename(filters));
  expect(exported.filename).toBe("shopee-income-accounting-2026-08-01-to-2026-08-31.xlsx");
  expect(exported.mimeType).toContain("spreadsheetml.sheet");
  expect(exported.buffer.subarray(0, 2).toString("ascii")).toBe("PK");
  expect(incomeRepository.listIncomeExportSourceDocuments).toHaveBeenCalledWith({
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
    shopCode: undefined,
  });
  expect(buildAccountingIncomeExportFilename({
    ...filters,
    shopCode: "dr-morepen",
  })).toBe("shopee-income-accounting-dr-morepen-2026-08-01-to-2026-08-31.xlsx");
});
