const ExcelJS = require("exceljs");
const {
  EXPORT_PAGE_SIZE,
  buildAccountingIncomeExportFilename,
  buildAccountingIncomeExportWorkbook,
  collectAllIncomeOrders,
  exportAccountingIncomeOrders,
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
    transferDate: "2026-08-01",
  }, {
    amount: 90,
    orderDate: "2026-08-03",
    orderNumber: "260803TEST002",
    sellerBalanceInflowDate: null,
    sellerBalanceNetAmount: null,
    sellerBalanceStatus: "not_covered",
    transferDate: "2026-08-05",
  }];
}

function exampleDocuments() {
  return [{
    checksumSha256: "a".repeat(64),
    endDate: "2026-08-07",
    filename: "weekly_report_20260801.pdf",
    kind: "statement",
    originalAvailable: true,
    originalPath: "/app/accounting-print-bundles/batch-1/items/statement-1/original",
    shopCode: "sc-drug-store",
    startDate: "2026-08-01",
  }, {
    checksumSha256: "b".repeat(64),
    endDate: "2026-08-07",
    filename: "Income.โอนเงินสำเร็จ.th.20260801_20260807.xlsx",
    kind: "income",
    originalAvailable: false,
    originalPath: null,
    shopCode: "sc-drug-store",
    startDate: "2026-08-01",
  }];
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
  expect(sources.getCell("A16").value).toBe("รายงานการเงิน");
  expect(sources.getCell("G16").value).toEqual({
    hyperlink: "https://api.example.test/api/app/accounting-print-bundles/batch-1/items/statement-1/original",
    text: "ดาวน์โหลดต้นฉบับ",
  });
  expect(sources.getCell("F17").value).toBe("ระบบเก็บเฉพาะข้อมูลที่อ่านได้");

  const orders = workbook.getWorksheet("รายการรายรับ");
  expect(orders.getCell("A2").value).toContain("01/08/2026 ถึง 31/08/2026");
  expect(orders.getCell("A4").value).toBe("หมายเลขคำสั่งซื้อ");
  expect(orders.getCell("C4").value).toBe("วันที่โอนชำระเงินสำเร็จ");
  expect(orders.getCell("A5").value).toBe("260730TEST001");
  expect(orders.getCell("D5").value).toBe(125.5);
  expect(orders.getCell("E5").value).toBe("เงินเข้าแล้ว");
  expect(orders.getCell("G6").value).toBeNull();
  expect(orders.autoFilter.toString()).toContain("A4:G6");
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
  });
});
