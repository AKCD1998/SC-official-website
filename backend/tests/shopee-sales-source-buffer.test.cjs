const crypto = require("node:crypto");
const ExcelJS = require("exceljs");
const {
  HEADERS: ORDER_HEADERS,
  readSalesSourceBuffer,
} = require("../src/modules/seamless/services/shopeeSalesSourceService");
const {
  HEADERS: CONFIRMED_HEADERS,
  readConfirmedSalesSourceBuffer,
} = require("../src/modules/seamless/services/shopeeConfirmedSalesService");

async function ordersBuffer() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("orders");
  sheet.addRow(Object.values(ORDER_HEADERS));
  sheet.addRow([
    "TESTORDER001",
    "สำเร็จแล้ว",
    "2026-09-08 12:00",
    "สินค้าทดสอบ",
    "หนึ่งกล่อง",
    1,
    100,
    90,
    5,
    10,
  ]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function confirmedBuffer() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("ยืนยันแล้ว");
  const headers = Object.values(CONFIRMED_HEADERS);
  sheet.addRow(headers);
  sheet.addRow(["08-09-2026-08-09-2026", 100, 2, 1, 20, 0, 0]);
  sheet.addRow([]);
  sheet.addRow(headers);
  sheet.addRow(["08-09-2026", 100, 2, 1, 20, 0, 0]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("buffer readers preserve caller-supplied original filenames and verify bytes", async () => {
  const orderBytes = await ordersBuffer();
  const orderHash = crypto.createHash("sha256").update(orderBytes).digest("hex");
  const orders = await readSalesSourceBuffer(orderBytes, {
    shopCode: "sc-drug-store",
    observedAt: "2026-09-09T02:00:00.000Z",
    sourceFilename: "Order.all.20260908_20260908.xlsx",
    sourceSha256: orderHash,
  });
  expect(orders.sourceFilename).toBe("Order.all.20260908_20260908.xlsx");
  expect(orders.sourceSha256).toBe(orderHash);
  expect(orders.facts).toHaveLength(1);

  const confirmedBytes = await confirmedBuffer();
  const confirmedHash = crypto.createHash("sha256").update(confirmedBytes).digest("hex");
  const confirmed = await readConfirmedSalesSourceBuffer(confirmedBytes, {
    shopCode: "sc-drug-store",
    observedAt: "2026-09-09T02:00:00.000Z",
    sourceFilename: "142wuxqhgi.shopee-shop-stats.20260908-20260908.xlsx",
    sourceSha256: confirmedHash,
  });
  expect(confirmed.sourceFilename).toBe("142wuxqhgi.shopee-shop-stats.20260908-20260908.xlsx");
  expect(confirmed.facts).toHaveLength(1);
  expect(confirmed.control).toMatchObject({ salesTotal: 100, orderCount: 2 });

  await expect(readSalesSourceBuffer(orderBytes, {
    shopCode: "sc-drug-store",
    observedAt: "2026-09-09T02:00:00.000Z",
    sourceFilename: "Order.all.20260908_20260908.xlsx",
    sourceSha256: "0".repeat(64),
  })).rejects.toThrow("SHA-256");
});

module.exports = { confirmedBuffer, ordersBuffer };
