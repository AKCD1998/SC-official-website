const crypto = require("node:crypto");
const ExcelJS = require("exceljs");
const XLSX = require("xlsx");
const { zipSync } = require("fflate");
const {
  BALANCE_HEADERS,
  INCOME_HEADERS,
  readIncomeSourceBuffer,
  readSellerBalanceSourceBuffer,
} = require("../src/modules/seamless/services/shopeeOfficialDocumentService");
const {
  CANCELLED_HEADERS,
  RETURN_HEADERS,
  readReturnSourceBuffer,
} = require("../src/modules/seamless/services/shopeeReturnSourceService");

function options(sourceFilename, shopCode = "sc-drug-store") {
  return {
    sourceFilename,
    shopCode,
    observedAt: "2026-09-09T16:00:00.000Z",
  };
}

async function incomeWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const summary = workbook.addWorksheet("Summary");
  summary.getCell("A6").value = "ชื่อผู้ใช้ (ผู้ขาย)";
  summary.getCell("B6").value = "142wuxqhgi";
  summary.getCell("B10").value = "2026-09-01";
  summary.getCell("B11").value = "2026-09-06";
  summary.getCell("A15").value = "3. จำนวนเงินทั้งหมดที่โอนแล้ว";
  summary.getCell("D15").value = 100;
  const income = workbook.addWorksheet("Income");
  income.getRow(6).values = Object.values(INCOME_HEADERS);
  income.getRow(7).values = [
    "260901TEST001", "", "2026-08-31", "2026-09-02", 140, -10, 0, -20, -10, 100,
  ];
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function balanceWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Transaction Report");
  sheet.getCell("A6").value = "ชื่อผู้ใช้ของผู้ขาย";
  sheet.getCell("B6").value = "142wuxqhgi";
  sheet.getCell("B7").value = "2026-09-01";
  sheet.getCell("B8").value = "2026-09-06";
  sheet.getCell("E12").value = 100;
  sheet.getCell("G12").value = 1;
  sheet.getCell("E13").value = -30;
  sheet.getCell("G13").value = 1;
  sheet.getRow(18).values = Object.values(BALANCE_HEADERS);
  sheet.getRow(19).values = [
    "2026-09-02 10:00", "รายรับจากคำสั่งซื้อ", "เงินจากคำสั่งซื้อ",
    "260901TEST001", "เงินเข้า", 100, "ทำรายการสำเร็จ", 1000,
  ];
  sheet.getRow(20).values = [
    "2026-09-03 11:00", "รายการปรับยอด", "ค่ารับพัสดุ", "-",
    "เงินออก", -30, "ทำรายการสำเร็จ", 970,
  ];
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function xlsBuffer(rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  return Buffer.from(XLSX.write(workbook, { bookType: "biff8", type: "buffer" }));
}

async function exceptionalCaseZip() {
  const cancelled = new ExcelJS.Workbook();
  const sheet = cancelled.addWorksheet("orders");
  sheet.addRow(Object.values(CANCELLED_HEADERS));
  sheet.addRow([
    "260901TEST001", "ยกเลิกแล้ว", "2026-09-01 09:00", 120,
    "ผู้ซื้อยกเลิก", "-",
  ]);
  sheet.getCell("E2").value = `${sheet.getCell("E2").value} buyer@example.com 081-234-5678`;
  const cancelledBytes = Buffer.from(await cancelled.xlsx.writeBuffer());
  const returnedBytes = xlsBuffer([
    Object.values(RETURN_HEADERS),
    ["RETURNTEST001", "260902TEST002", "2026-09-02 09:00", "2026-09-05 12:00",
      "คืนเงินแล้ว", "คืนเงิน", "สินค้าเสียหาย", 75],
  ]);
  return Buffer.from(zipSync({
    "Order.cancelled.20260901_20260907_part_1_of_1.xlsx": new Uint8Array(cancelledBytes),
    "Order.return_refund.20260901_20260907_part_1_of_1.xls": new Uint8Array(returnedBytes),
  }));
}

test("My Income validates exact shop, period, status and Summary total", async () => {
  const buffer = await incomeWorkbook();
  const source = await readIncomeSourceBuffer(buffer, {
    ...options("Income.โอนเงินสำเร็จ.th.20260901_20260906.xlsx"),
    reportType: "income-transferred",
  });
  expect(source).toMatchObject({
    reportType: "income-transferred",
    startDate: "2026-09-01",
    endDate: "2026-09-06",
    control: { transferredTotal: 100, orderCount: 1 },
  });
  expect(source.facts[0]).toMatchObject({
    orderNumber: "260901TEST001",
    payoutAmount: 100,
    orderedAt: "2026-08-30T17:00:00.000Z",
    transferredAt: "2026-09-01T17:00:00.000Z",
  });
  await expect(readIncomeSourceBuffer(buffer, {
    ...options("Income.รอดำเนินการ.th.20260901_20260906.xlsx"),
    reportType: "income-transferred",
  })).rejects.toThrow(/status does not match/iu);
});

test("Seller Balance separates order-linked money from unrelated adjustments", async () => {
  const source = await readSellerBalanceSourceBuffer(
    await balanceWorkbook(),
    options("my_balance_transaction_report.shopee.20260901_20260906.xlsx"),
  );
  expect(source.control).toEqual({
    inflowTotal: 100,
    inflowCount: 1,
    outflowTotal: -30,
    outflowCount: 1,
    orderTotal: 100,
    orderCount: 1,
    adjustmentTotal: -30,
    adjustmentCount: 1,
  });
});

test("exceptional-case ZIP keeps Shopee's exclusive filename end and stores no buyer fields", async () => {
  const buffer = await exceptionalCaseZip();
  const source = await readReturnSourceBuffer(
    buffer,
    options("Order.return_refund_cancel.20260901_20260907.zip"),
  );
  expect(source).toMatchObject({
    startDate: "2026-09-01",
    endDate: "2026-09-06",
    control: {
      counts: { cancelled: 1, failed_delivery: 0, return_refund: 1 },
      amounts: { cancelled: 120, failed_delivery: 0, return_refund: 75 },
    },
  });
  expect(source.facts.map((fact) => fact.eventType).sort()).toEqual(["cancelled", "return_refund"]);
  expect(JSON.stringify(source.facts)).not.toMatch(/"(?:buyer|address|phone|username)[^"]*"\s*:/iu);
  expect(JSON.stringify(source.facts)).not.toMatch(/buyer@example\.com|081-234-5678/iu);
  expect(source.facts.find((fact) => fact.eventType === "cancelled").reason)
    .toMatch(/\[redacted-email\].*\[redacted-phone\]/u);
  expect(source.sourceSha256).toBe(crypto.createHash("sha256").update(buffer).digest("hex"));
});
