const crypto = require("node:crypto");
const path = require("node:path");
const { PDFDocument } = require("pdf-lib");
const { requireShopeeShopCode, SHOPEE_SHOP_PROFILES } = require("./shopeeShops");

const INCOME_HEADERS = Object.freeze({
  orderNumber: "หมายเลขคำสั่งซื้อ",
  returnRequestNumber: "รหัสคืนสินค้า",
  orderedAt: "วันที่ทำการสั่งซื้อ",
  transferredAt: "วันที่โอนชำระเงินสำเร็จ",
  productRegularAmount: "สินค้าราคาปกติ",
  sellerProductDiscount: "ส่วนลดสินค้าจากผู้ขาย",
  buyerRefund: "จำนวนเงินที่ทำการคืนให้ผู้ซื้อ",
  shopeeProductDiscount: "ส่วนลดสินค้าที่ออกโดย Shopee",
  sellerVoucher: "โค้ดส่วนลดที่ออกโดยผู้ขาย",
  payoutAmount: "จำนวนเงินทั้งหมดที่โอนแล้ว (฿)",
});
const BALANCE_HEADERS = Object.freeze({
  transactionAt: "วันที่",
  transactionType: "ประเภทการทำธุรกรรม",
  description: "คำอธิบาย",
  orderNumber: "รหัสคำสั่งซื้อ",
  direction: "รูปแบบธุรกรรม",
  amount: "จำนวนเงิน",
  status: "สถานะ",
  balanceAfter: "ยอดเงินหลังทำธุรกรรมเสร็จสิ้น",
});
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const ORDER_PATTERN = /^[A-Z0-9]{8,40}$/u;

function text(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace("T", " ");
  if (value && typeof value === "object") {
    throw new Error("Formula or rich-text cells are not supported in official Shopee reports.");
  }
  return String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
}

function isoDate(value, label = "date") {
  const result = text(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(result)) throw new Error(`Invalid ${label}.`);
  const parsed = new Date(`${result}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new Error(`Invalid ${label}.`);
  }
  return result;
}

function parseBangkokTimestamp(value, label, { nullable = false } = {}) {
  const raw = text(value);
  if (nullable && (!raw || raw === "-")) return null;
  // Shopee uses date-only values in My Income, but timestamps in Seller
  // Balance and the return/refund workbook. Treat a date-only source value as
  // midnight in the report's documented Asia/Bangkok timezone.
  const match = /^(\d{4}-\d{2}-\d{2})(?:(?:\s+|T)(\d{2}:\d{2})(?::(\d{2}))?)?$/u.exec(raw);
  if (!match) throw new Error(`Invalid ${label}.`);
  const date = isoDate(match[1], label);
  const clock = `${date}T${match[2] || "00:00"}:${match[3] || "00"}`;
  const instant = new Date(`${clock}+07:00`);
  if (Number.isNaN(instant.getTime())
    || new Date(instant.getTime() + 7 * 3600000).toISOString().slice(0, 19) !== clock) {
    throw new Error(`Invalid ${label}.`);
  }
  return instant.toISOString();
}

function addDays(value, days) {
  return new Date(Date.parse(`${isoDate(value)}T00:00:00.000Z`) + days * 86400000)
    .toISOString().slice(0, 10);
}

function compactDate(value) {
  const match = /^(\d{4})(\d{2})(\d{2})$/u.exec(value);
  if (!match) throw new Error("Invalid compact date.");
  return isoDate(`${match[1]}-${match[2]}-${match[3]}`);
}

function cents(value, label, { nullable = false } = {}) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Invalid ${label}.`);
    const result = Math.round(value * 100);
    if (Math.abs(value * 100 - result) > 1e-7 || !Number.isSafeInteger(result)) {
      throw new Error(`Invalid ${label} precision.`);
    }
    return result;
  }
  const raw = text(value).replace(/[฿,\s]/gu, "").replace(/[−–—]/gu, "-");
  if (nullable && (!raw || raw === "-")) return null;
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/u.exec(raw);
  if (!match) throw new Error(`Invalid ${label}.`);
  const result = (Number(match[2]) * 100 + Number((match[3] || "").padEnd(2, "0")))
    * (match[1] ? -1 : 1);
  if (!Number.isSafeInteger(result)) throw new Error(`Invalid ${label} precision.`);
  return result;
}

function amount(centsValue) {
  return centsValue == null ? null : centsValue / 100;
}

function exactColumns(headers, expected) {
  return Object.fromEntries(Object.entries(expected).map(([key, label]) => {
    const matches = headers.flatMap((value, index) => value === label ? [index] : []);
    if (matches.length !== 1) throw new Error(`Missing or duplicate Shopee header: ${label}`);
    return [key, matches[0]];
  }));
}

function sourceBase({ buffer, sourceFilename, sourceSha256, shopCode, observedAt }) {
  requireShopeeShopCode(shopCode);
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("Original Shopee source bytes are required.");
  const computed = crypto.createHash("sha256").update(buffer).digest("hex");
  if (sourceSha256 && (!HASH_PATTERN.test(sourceSha256) || sourceSha256 !== computed)) {
    throw new Error("Source SHA-256 does not match source bytes.");
  }
  const observed = new Date(observedAt);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(observedAt || "")
    || Number.isNaN(observed.getTime())) throw new Error("Explicit ISO observation time with timezone is required.");
  const filename = path.basename(sourceFilename);
  if (!filename || filename !== sourceFilename || /[\\/]/u.test(sourceFilename) || filename.length > 255) {
    throw new Error("Unsafe source filename.");
  }
  return { shopCode, sourceFilename: filename, sourceSha256: computed, observedAt: observed.toISOString() };
}

function validateCompletedPeriod(startDate, endDate, observedAt) {
  if (endDate < startDate) throw new Error("Invalid source period.");
  if (Date.parse(`${endDate}T23:59:59+07:00`) > Date.parse(observedAt)) {
    throw new Error("Report period has not finished at the observation time.");
  }
}

async function excelRows(buffer, sheetName) {
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw new Error(`Missing Shopee worksheet: ${sheetName}`);
  if (sheet.rowCount > 100000 || sheet.columnCount > 100) throw new Error("Shopee worksheet exceeds supported bounds.");
  const rows = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    rows.push(Array.from({ length: sheet.columnCount }, (_, index) => row.getCell(index + 1).value));
  });
  return { workbook, sheet, rows };
}

function sellerUsername(shopCode) {
  return SHOPEE_SHOP_PROFILES[shopCode]?.statisticsUsername;
}

async function readFinancialStatementSourceBuffer(buffer, options) {
  const base = sourceBase({ buffer, ...options });
  const filenameMatch = /^weekly_report_(\d{4})(\d{2})(\d{2})(?: ?\(\d+\))?\.pdf$/iu.exec(base.sourceFilename);
  if (!filenameMatch) throw new Error("Expected weekly_report_YYYYMMDD.pdf filename.");
  const pdf = await PDFDocument.load(buffer);
  const pageCount = pdf.getPageCount();
  if (pageCount < 1 || pageCount > 20) throw new Error("Unsupported Financial Statement page count.");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false });
  const document = await task.promise;
  let items;
  try {
    const page = await document.getPage(1);
    items = (await page.getTextContent()).items.map((item) => text(item.str)).filter(Boolean);
  } finally {
    await task.destroy();
  }
  const joined = items.join(" ");
  const dates = [...joined.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/gu)].map((match) => match[1]);
  if (dates.length < 2) throw new Error("Financial Statement period is missing.");
  const startDate = isoDate(dates[0]);
  const endDate = isoDate(dates[1]);
  if (startDate !== compactDate(`${filenameMatch[1]}${filenameMatch[2]}${filenameMatch[3]}`)
    || addDays(startDate, 6) !== endDate) throw new Error("Financial Statement filename or weekly period mismatch.");
  validateCompletedPeriod(startDate, endDate, base.observedAt);
  if (!items.includes(sellerUsername(base.shopCode))) throw new Error("Financial Statement does not identify the selected shop.");
  const detailIndex = items.findIndex((value) => value.replace(/\s/gu, "").includes("รายละเอียดการโอนเงิน"));
  const summaryItems = detailIndex < 0 ? items : items.slice(0, detailIndex);
  const currencyValues = summaryItems.filter((value) => /^฿[\d,]+(?:\.\d{1,2})?$/u.test(value));
  if (currencyValues.length !== 1) throw new Error("Financial Statement transfer control is missing or ambiguous.");
  const transferredTotal = amount(cents(currencyValues[0], "Financial Statement transferred total"));
  return {
    ...base,
    reportType: "financial-statement",
    startDate,
    endDate,
    control: { transferredTotal, pageCount },
    facts: [{ transferredTotal, pageCount }],
  };
}

async function readIncomeSourceBuffer(buffer, { reportType, ...options }) {
  if (!["income-transferred", "income-pending"].includes(reportType)) throw new Error("Unsupported My Income report type.");
  const base = sourceBase({ buffer, ...options });
  const filenameMatch = /^Income\.(โอนเงินสำเร็จ|รอดำเนินการ)\.th\.(\d{8})_(\d{8})(?: ?\(\d+\))?\.xlsx$/iu.exec(base.sourceFilename);
  if (!filenameMatch) throw new Error("Expected original Income status filename.");
  const expectedStatus = reportType === "income-transferred" ? "โอนเงินสำเร็จ" : "รอดำเนินการ";
  if (filenameMatch[1] !== expectedStatus) throw new Error("My Income filename status does not match the report type.");
  const startDate = compactDate(filenameMatch[2]);
  const endDate = compactDate(filenameMatch[3]);
  validateCompletedPeriod(startDate, endDate, base.observedAt);
  const { workbook, rows } = await excelRows(buffer, "Income");
  const summary = workbook.getWorksheet("Summary");
  if (!summary) throw new Error("Missing Shopee Summary worksheet.");
  if (text(summary.getCell("A6").value) !== "ชื่อผู้ใช้ (ผู้ขาย)"
    || text(summary.getCell("B6").value) !== sellerUsername(base.shopCode)) {
    throw new Error("My Income report does not identify the selected shop.");
  }
  if (isoDate(summary.getCell("B10").value) !== startDate
    || isoDate(summary.getCell("B11").value) !== endDate) {
    throw new Error("My Income period does not match the filename.");
  }
  const headers = (rows[5] || []).map(text);
  const columns = exactColumns(headers, INCOME_HEADERS);
  const facts = [];
  for (const [offset, row] of rows.slice(6).entries()) {
    if (row.every((value) => !text(value))) continue;
    const sourceRow = offset + 7;
    const orderNumber = text(row[columns.orderNumber]).toUpperCase();
    if (!ORDER_PATTERN.test(orderNumber)) throw new Error(`Invalid My Income order at row ${sourceRow}.`);
    const orderedAt = parseBangkokTimestamp(row[columns.orderedAt], "My Income order date");
    if (new Date(orderedAt) > new Date(base.observedAt)) throw new Error("My Income order is later than the observation time.");
    const transferredAt = parseBangkokTimestamp(row[columns.transferredAt], "My Income transfer date", {
      nullable: reportType === "income-pending",
    });
    if (reportType === "income-transferred") {
      const transferDate = new Date(new Date(transferredAt).getTime() + 7 * 3600000).toISOString().slice(0, 10);
      if (transferDate < startDate || transferDate > endDate) throw new Error("My Income transfer date is outside the source period.");
    }
    const payoutCents = cents(row[columns.payoutAmount], "My Income payout amount");
    facts.push({
      shopCode: base.shopCode,
      sourceRow,
      orderNumber,
      returnRequestNumber: text(row[columns.returnRequestNumber]) || null,
      orderedAt,
      transferredAt,
      payoutAmount: amount(payoutCents),
      components: {
        productRegularAmount: amount(cents(row[columns.productRegularAmount], "regular product amount", { nullable: true })),
        sellerProductDiscount: amount(cents(row[columns.sellerProductDiscount], "seller product discount", { nullable: true })),
        buyerRefund: amount(cents(row[columns.buyerRefund], "buyer refund", { nullable: true })),
        shopeeProductDiscount: amount(cents(row[columns.shopeeProductDiscount], "Shopee product discount", { nullable: true })),
        sellerVoucher: amount(cents(row[columns.sellerVoucher], "seller voucher", { nullable: true })),
      },
    });
  }
  const summaryRows = [];
  summary.eachRow({ includeEmpty: true }, (row) => summaryRows.push([text(row.getCell(1).value), row.getCell(4).value]));
  const controls = summaryRows.filter(([label]) => label === "3. จำนวนเงินทั้งหมดที่โอนแล้ว");
  if (controls.length !== 1) throw new Error("My Income summary transfer control is missing or ambiguous.");
  const transferredTotalCents = cents(controls[0][1], "My Income summary transfer total");
  const factTotalCents = facts.reduce((sum, fact) => sum + cents(fact.payoutAmount, "My Income payout amount"), 0);
  if (!Number.isSafeInteger(factTotalCents) || factTotalCents !== transferredTotalCents) {
    throw new Error("My Income detail does not reconcile to its Summary worksheet.");
  }
  return {
    ...base,
    reportType,
    startDate,
    endDate,
    control: { transferredTotal: amount(transferredTotalCents), orderCount: facts.length },
    facts,
  };
}

async function readSellerBalanceSourceBuffer(buffer, options) {
  const base = sourceBase({ buffer, ...options });
  const filenameMatch = /^my_balance_transaction_report\.shopee\.(\d{8})_(\d{8})(?: ?\(\d+\))?\.xlsx$/iu.exec(base.sourceFilename);
  if (!filenameMatch) throw new Error("Expected original Seller Balance filename.");
  const startDate = compactDate(filenameMatch[1]);
  const endDate = compactDate(filenameMatch[2]);
  validateCompletedPeriod(startDate, endDate, base.observedAt);
  const { rows } = await excelRows(buffer, "Transaction Report");
  if (text(rows[5]?.[0]) !== "ชื่อผู้ใช้ของผู้ขาย" || text(rows[5]?.[1]) !== sellerUsername(base.shopCode)) {
    throw new Error("Seller Balance report does not identify the selected shop.");
  }
  if (isoDate(rows[6]?.[1]) !== startDate || isoDate(rows[7]?.[1]) !== endDate) {
    throw new Error("Seller Balance period does not match the filename.");
  }
  const headers = (rows[17] || []).map(text);
  const columns = exactColumns(headers, BALANCE_HEADERS);
  const facts = [];
  for (const [offset, row] of rows.slice(18).entries()) {
    if (row.every((value) => !text(value))) continue;
    const sourceRow = offset + 19;
    const transactionAt = parseBangkokTimestamp(row[columns.transactionAt], "Seller Balance transaction date");
    const transactionDate = new Date(new Date(transactionAt).getTime() + 7 * 3600000).toISOString().slice(0, 10);
    if (transactionDate < startDate || transactionDate > endDate) throw new Error("Seller Balance transaction is outside the source period.");
    const direction = text(row[columns.direction]);
    if (!["เงินเข้า", "เงินออก"].includes(direction)) throw new Error("Unsupported Seller Balance direction.");
    const valueCents = cents(row[columns.amount], "Seller Balance amount");
    if ((direction === "เงินเข้า" && valueCents < 0) || (direction === "เงินออก" && valueCents > 0)) {
      throw new Error("Seller Balance direction and amount sign disagree.");
    }
    const rawOrder = text(row[columns.orderNumber]).toUpperCase();
    const orderNumber = rawOrder && rawOrder !== "-" ? rawOrder : null;
    if (orderNumber && !ORDER_PATTERN.test(orderNumber)) throw new Error("Invalid Seller Balance order number.");
    facts.push({
      shopCode: base.shopCode,
      sourceRow,
      transactionAt,
      transactionType: text(row[columns.transactionType]),
      orderNumber,
      direction,
      amount: amount(valueCents),
      status: text(row[columns.status]),
      balanceAfter: amount(cents(row[columns.balanceAfter], "Seller Balance running balance")),
    });
  }
  const summary = [
    { direction: "เงินเข้า", row: rows[11] },
    { direction: "เงินออก", row: rows[12] },
  ].map(({ direction, row }) => ({
    direction,
    amountCents: cents(row?.[4], `Seller Balance ${direction} summary`),
    count: Number(row?.[6]),
  }));
  for (const control of summary) {
    if (!Number.isSafeInteger(control.count) || control.count < 0) throw new Error("Invalid Seller Balance summary count.");
    const selected = facts.filter((fact) => fact.direction === control.direction);
    const total = selected.reduce((sum, fact) => sum + cents(fact.amount, "Seller Balance amount"), 0);
    if (selected.length !== control.count || total !== control.amountCents) {
      throw new Error(`Seller Balance ${control.direction} detail does not reconcile to Summary.`);
    }
  }
  const orderFacts = facts.filter((fact) => fact.orderNumber && fact.status === "ทำรายการสำเร็จ");
  const orderTotalCents = orderFacts.reduce((sum, fact) => sum + cents(fact.amount, "Seller Balance order amount"), 0);
  const adjustmentFacts = facts.filter((fact) => !fact.orderNumber);
  const adjustmentTotalCents = adjustmentFacts.reduce((sum, fact) => sum + cents(fact.amount, "Seller Balance adjustment"), 0);
  return {
    ...base,
    reportType: "seller-balance",
    startDate,
    endDate,
    control: {
      inflowTotal: amount(summary[0].amountCents),
      inflowCount: summary[0].count,
      outflowTotal: amount(summary[1].amountCents),
      outflowCount: summary[1].count,
      orderTotal: amount(orderTotalCents),
      orderCount: orderFacts.length,
      adjustmentTotal: amount(adjustmentTotalCents),
      adjustmentCount: adjustmentFacts.length,
    },
    facts,
  };
}

module.exports = {
  BALANCE_HEADERS,
  INCOME_HEADERS,
  addDays,
  amount,
  cents,
  compactDate,
  exactColumns,
  excelRows,
  isoDate,
  parseBangkokTimestamp,
  readFinancialStatementSourceBuffer,
  readIncomeSourceBuffer,
  readSellerBalanceSourceBuffer,
  sourceBase,
  text,
  validateCompletedPeriod,
};
