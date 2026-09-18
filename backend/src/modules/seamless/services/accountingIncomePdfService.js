const fs = require("node:fs/promises");
const path = require("node:path");
const fontkit = require("@pdf-lib/fontkit");
const { PDFDocument, rgb } = require("pdf-lib");
const { readFinancialStatementSourceBuffer } = require("./shopeeOfficialDocumentService");

const A4_LANDSCAPE = Object.freeze([841.89, 595.28]);
const FONT_PATH = path.resolve(
  __dirname,
  "../../digitalpjk/assets/fonts/THSarabunNew.ttf",
);
const MAX_APPENDIX_BYTES = 100 * 1024 * 1024;
const MAX_APPENDIX_PAGES = 500;
const ORDER_ROWS_PER_PAGE = 18;
const INDEX_ROWS_PER_PAGE = 18;
const RECONCILIATION_ROWS_PER_PAGE = 12;
const COLORS = Object.freeze({
  blue: rgb(31 / 255, 78 / 255, 120 / 255),
  border: rgb(205 / 255, 217 / 255, 232 / 255),
  ink: rgb(31 / 255, 41 / 255, 55 / 255),
  muted: rgb(95 / 255, 107 / 255, 122 / 255),
  paleBlue: rgb(238 / 255, 245 / 255, 251 / 255),
  paleGray: rgb(238 / 255, 241 / 255, 245 / 255),
  paleGreen: rgb(198 / 255, 239 / 255, 206 / 255),
  paleRed: rgb(1, 199 / 255, 206 / 255),
  paleYellow: rgb(1, 235 / 255, 156 / 255),
  white: rgb(1, 1, 1),
});
const STATUS_COLORS = Object.freeze({
  amount_mismatch: rgb(1, 235 / 255, 156 / 255),
  credited: rgb(198 / 255, 239 / 255, 206 / 255),
  not_covered: rgb(221 / 255, 235 / 255, 247 / 255),
  not_found_in_covered_report: rgb(1, 235 / 255, 156 / 255),
  outflow_or_reversed: rgb(1, 199 / 255, 206 / 255),
});

function fitText(font, value, size, maxWidth) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!text || font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  const suffix = "...";
  let result = "";
  for (const character of text) {
    if (font.widthOfTextAtSize(`${result}${character}${suffix}`, size) > maxWidth) break;
    result += character;
  }
  return `${result}${suffix}`;
}

function formatDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(value || ""));
  return match ? `${match[3]}/${match[2]}/${match[1]}` : "-";
}

function formatMoney(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? `${number.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท`
    : "-";
}

function drawText(page, font, value, {
  align = "left",
  color = COLORS.ink,
  maxWidth = Number.POSITIVE_INFINITY,
  size = 12,
  x,
  y,
}) {
  const text = fitText(font, value, size, maxWidth);
  const width = font.widthOfTextAtSize(text, size);
  const adjustedX = align === "right" ? x + maxWidth - width
    : align === "center" ? x + (maxWidth - width) / 2 : x;
  page.drawText(text, { x: adjustedX, y, size, font, color });
}

function drawFooter(page, font, pageNumber, totalPages) {
  page.drawLine({
    start: { x: 28, y: 27 },
    end: { x: A4_LANDSCAPE[0] - 28, y: 27 },
    color: COLORS.border,
    thickness: 0.6,
  });
  drawText(page, font, "ชุดข้อมูลรายรับสำหรับบัญชี", {
    color: COLORS.muted,
    maxWidth: 360,
    size: 9,
    x: 30,
    y: 14,
  });
  drawText(page, font, `หน้า ${pageNumber} จาก ${totalPages}`, {
    align: "right",
    color: COLORS.muted,
    maxWidth: 180,
    size: 9,
    x: A4_LANDSCAPE[0] - 210,
    y: 14,
  });
}

function drawTitle(page, font, title, subtitle = "") {
  drawText(page, font, title, {
    color: COLORS.blue,
    maxWidth: A4_LANDSCAPE[0] - 60,
    size: 22,
    x: 30,
    y: 551,
  });
  if (subtitle) {
    drawText(page, font, subtitle, {
      color: COLORS.muted,
      maxWidth: A4_LANDSCAPE[0] - 60,
      size: 12,
      x: 30,
      y: 530,
    });
  }
}

function drawCover(pdf, font, { documents, filters, orders, summary, sourcePolicy }) {
  const page = pdf.addPage(A4_LANDSCAPE);
  drawTitle(
    page,
    font,
    "ชุดข้อมูลรายรับสำหรับบัญชี",
    "เอกสารรวมสำหรับตรวจสอบ พิมพ์ และแนบหลักฐาน Shopee ต้นฉบับ",
  );

  const metadata = [
    ["ร้าน", filters.shopLabel],
    ["ช่วงวันที่โอนชำระเงินสำเร็จ", `${formatDate(filters.dateFrom)} ถึง ${formatDate(filters.dateTo)}`],
    ["เขตเวลา", "Asia/Bangkok"],
    ["เลขคำสั่งซื้อ", filters.orderNumber || "ทั้งหมด"],
  ];
  let y = 489;
  for (const [label, value] of metadata) {
    page.drawRectangle({ x: 30, y: y - 7, width: 220, height: 27, color: COLORS.paleBlue });
    drawText(page, font, label, { color: COLORS.blue, maxWidth: 204, size: 12, x: 38, y });
    drawText(page, font, value, { maxWidth: 532, size: 12, x: 267, y });
    y -= 34;
  }

  const summaries = [
    ["จำนวนรายการ", Number(summary.orderCount || orders.length).toLocaleString("en-US")],
    ["ยอด Income รวม", formatMoney(summary.totalIncome)],
    ["เงินเข้า Seller Balance แล้ว", Number(summary.creditedCount || 0).toLocaleString("en-US")],
  ];
  summaries.forEach(([label, value], index) => {
    const x = 30 + index * 262;
    page.drawRectangle({
      x,
      y: 282,
      width: 246,
      height: 70,
      borderColor: COLORS.border,
      borderWidth: 1,
      color: COLORS.paleBlue,
    });
    drawText(page, font, label, { color: COLORS.muted, maxWidth: 226, size: 11, x: x + 10, y: 325 });
    drawText(page, font, value, { color: COLORS.blue, maxWidth: 226, size: 18, x: x + 10, y: 297 });
  });

  page.drawRectangle({
    x: 30,
    y: 174,
    width: A4_LANDSCAPE[0] - 60,
    height: 82,
    borderColor: COLORS.border,
    borderWidth: 1,
    color: rgb(250 / 255, 252 / 255, 1),
  });
  drawText(page, font, "หลักฐานต้นฉบับที่ใช้", {
    color: COLORS.blue,
    maxWidth: 760,
    size: 14,
    x: 42,
    y: 232,
  });
  const policy = sourcePolicy.fullCalendarMonth
    ? "ช่วงเดือนเต็ม: รวมรายงานการเงินรายเดือนที่ตรงทั้งเดือน และรายงานรายสัปดาห์ทุกสัปดาห์ที่ทับซ้อน"
    : "ช่วงไม่ครบเดือน: รวมรายงานการเงินรายสัปดาห์ทุกสัปดาห์ที่ทับซ้อน โดยไม่ใส่รายงานรายเดือน";
  drawText(page, font, policy, { maxWidth: 752, size: 11, x: 42, y: 208 });
  drawText(
    page,
    font,
    `พบไฟล์ต้นฉบับ ${summary.availableOriginalCount || 0} รายการ | ยังขาด ${summary.missingOriginalCount || 0} รายการ | รายการอ้างอิงทั้งหมด ${documents.length}`,
    { color: COLORS.muted, maxWidth: 752, size: 11, x: 42, y: 185 },
  );

  drawText(page, font, "โครงสร้างเอกสาร", {
    color: COLORS.blue,
    maxWidth: 760,
    size: 14,
    x: 30,
    y: 140,
  });
  drawText(page, font, "1. หน้าปก  2. ตารางรายการรายรับ  3. กระทบยอดรายสัปดาห์  4. ดัชนีภาคผนวก  5. PDF Shopee ต้นฉบับ", {
    maxWidth: 780,
    size: 12,
    x: 30,
    y: 117,
  });
  drawText(page, font, "หมายเหตุ: เอกสารที่ระบุว่าขาดไฟล์จะปรากฏในดัชนี แต่จะไม่มีหน้าต้นฉบับต่อท้ายจนกว่าจะอัปโหลดไฟล์", {
    color: COLORS.muted,
    maxWidth: 780,
    size: 11,
    x: 30,
    y: 91,
  });
  return page;
}

const ORDER_COLUMNS = Object.freeze([
  { key: "orderNumber", label: "หมายเลขคำสั่งซื้อ", width: 125 },
  { key: "shopLabel", label: "ร้าน", width: 74 },
  { key: "orderDate", label: "วันที่สั่งซื้อ", width: 80 },
  { key: "transferDate", label: "วันที่โอนสำเร็จ", width: 88 },
  { key: "amount", label: "จำนวนเงินทั้งหมด", width: 84, align: "right" },
  { key: "sellerBalanceStatusLabel", label: "สถานะ Seller Balance", width: 135 },
  { key: "sellerBalanceInflowDate", label: "วันที่เงินเข้า", width: 96 },
  { key: "sellerBalanceNetAmount", label: "ยอดสุทธิ", width: 102, align: "right" },
]);

function orderCellValue(order, key) {
  if (["orderDate", "transferDate", "sellerBalanceInflowDate"].includes(key)) {
    return formatDate(order[key]);
  }
  if (key === "amount") return formatMoney(order.amount);
  if (key === "sellerBalanceNetAmount") {
    return order.sellerBalanceNetAmount == null ? "-" : formatMoney(order.sellerBalanceNetAmount);
  }
  return order[key] || "-";
}

function drawOrderPages(pdf, font, { filters, orders }) {
  const chunks = [];
  if (!orders.length) chunks.push([]);
  for (let index = 0; index < orders.length; index += ORDER_ROWS_PER_PAGE) {
    chunks.push(orders.slice(index, index + ORDER_ROWS_PER_PAGE));
  }
  return chunks.map((chunk, pageIndex) => {
    const page = pdf.addPage(A4_LANDSCAPE);
    drawTitle(
      page,
      font,
      "รายการรายรับจาก Income",
      `ร้าน ${filters.shopLabel} | วันที่โอนชำระเงินสำเร็จ ${formatDate(filters.dateFrom)} ถึง ${formatDate(filters.dateTo)} | หน้าตาราง ${pageIndex + 1}/${chunks.length}`,
    );
    const tableX = 29;
    const headerY = 486;
    const headerHeight = 35;
    let x = tableX;
    for (const column of ORDER_COLUMNS) {
      page.drawRectangle({ x, y: headerY, width: column.width, height: headerHeight, color: COLORS.blue });
      drawText(page, font, column.label, {
        align: "center",
        color: COLORS.white,
        maxWidth: column.width - 8,
        size: 10,
        x: x + 4,
        y: headerY + 12,
      });
      x += column.width;
    }
    if (!chunk.length) {
      drawText(page, font, "ไม่พบรายการตามเงื่อนไข", {
        align: "center",
        color: COLORS.muted,
        maxWidth: 784,
        size: 14,
        x: tableX,
        y: 444,
      });
      return page;
    }
    chunk.forEach((order, rowIndex) => {
      const rowY = headerY - (rowIndex + 1) * 24;
      let cellX = tableX;
      ORDER_COLUMNS.forEach((column) => {
        const fill = column.key === "sellerBalanceStatusLabel"
          ? STATUS_COLORS[order.sellerBalanceStatus] : null;
        page.drawRectangle({
          x: cellX,
          y: rowY,
          width: column.width,
          height: 24,
          borderColor: COLORS.border,
          borderWidth: 0.5,
          color: fill || (rowIndex % 2 ? rgb(248 / 255, 250 / 255, 252 / 255) : COLORS.white),
        });
        drawText(page, font, orderCellValue(order, column.key), {
          align: column.align || "left",
          maxWidth: column.width - 8,
          size: 9.5,
          x: cellX + 4,
          y: rowY + 7,
        });
        cellX += column.width;
      });
    });
    return page;
  });
}

async function loadAppendixEntries(documents, storage) {
  const entries = [];
  const skipped = new Map();
  let totalBytes = 0;
  let totalPages = 0;
  for (const document of documents) {
    if (!document.originalAvailable || !document.sourceFile) continue;
    const buffer = Buffer.from(await storage.readStoredFile(
      document.sourceFile.storageProvider,
      document.sourceFile.storagePath,
      document.sourceFile.storageBucket,
    ));
    if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
      skipped.set(document, "ไฟล์ต้นฉบับไม่ใช่ PDF");
      continue;
    }
    totalBytes += buffer.length;
    if (totalBytes > MAX_APPENDIX_BYTES) {
      const error = new Error("Combined accounting PDF exceeds the 100 MB original-file limit. Narrow the date range.");
      error.statusCode = 413;
      throw error;
    }
    let sourcePdf;
    try {
      sourcePdf = await PDFDocument.load(buffer);
    } catch (error) {
      const invalid = new Error(`Unable to append original PDF: ${document.filename}`);
      invalid.statusCode = 422;
      throw invalid;
    }
    const pageCount = sourcePdf.getPageCount();
    totalPages += pageCount;
    if (totalPages > MAX_APPENDIX_PAGES) {
      const error = new Error("Combined accounting PDF exceeds the 500-page appendix limit. Narrow the date range.");
      error.statusCode = 413;
      throw error;
    }
    let transferredTotal = null;
    let transferredTotalError = "";
    if (document.kind === "statement" && document.periodType === "weekly") {
      try {
        const parsed = await readFinancialStatementSourceBuffer(buffer, {
          observedAt: new Date().toISOString(),
          shopCode: document.shopCode,
          sourceFilename: document.filename,
          sourceSha256: document.checksumSha256 || undefined,
        });
        transferredTotal = parsed.control.transferredTotal;
      } catch (error) {
        transferredTotalError = error?.message || "อ่านยอดรวมจาก PDF ไม่สำเร็จ";
      }
    }
    entries.push({ document, pageCount, sourcePdf, transferredTotal, transferredTotalError });
  }
  return { entries, skipped };
}

function amountCents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

function centsAmount(value) {
  return Math.round(value) / 100;
}

function buildWeeklyReconciliation({ documents, entries = [], filters, orders = [] }) {
  const entryByDocument = new Map(entries.map((entry) => [entry.document, entry]));
  const rows = documents
    .filter((document) => document.kind === "statement" && document.periodType === "weekly")
    .map((document) => {
      const overlapStart = document.startDate > filters.dateFrom ? document.startDate : filters.dateFrom;
      const overlapEnd = document.endDate < filters.dateTo ? document.endDate : filters.dateTo;
      const matchingOrders = orders.filter((order) => (
        order.shopCode === document.shopCode
        && order.transferDate >= overlapStart
        && order.transferDate <= overlapEnd
      ));
      const includedCents = matchingOrders.reduce((total, order) => total + amountCents(order.amount), 0);
      const entry = entryByDocument.get(document);
      const fullCents = entry?.transferredTotal == null
        ? null
        : amountCents(entry.transferredTotal);
      const isBoundary = document.startDate < filters.dateFrom || document.endDate > filters.dateTo;
      let status = "matched";
      let statusLabel = "ตรงกัน";
      if (!document.originalAvailable || !entry) {
        status = "awaiting_original";
        statusLabel = "รอไฟล์ต้นฉบับ";
      } else if (fullCents == null) {
        status = "unreadable_total";
        statusLabel = "อ่านยอดต้นฉบับไม่ได้";
      } else if (!isBoundary && fullCents !== includedCents) {
        status = "mismatch";
        statusLabel = "ยอดไม่ตรง";
      } else if (isBoundary && fullCents < includedCents) {
        status = "mismatch";
        statusLabel = "ยอดนับเกินต้นฉบับ";
      } else if (isBoundary) {
        status = includedCents === 0 ? "excluded" : "partial_overlap";
        statusLabel = includedCents === 0 ? "ไม่นับในช่วง" : "นับเฉพาะวันที่ในช่วง";
      }
      return {
        document,
        excludedAmount: fullCents == null ? null : centsAmount(fullCents - includedCents),
        fullDocumentAmount: fullCents == null ? null : centsAmount(fullCents),
        includedAmount: centsAmount(includedCents),
        isBoundary,
        orderCount: matchingOrders.length,
        overlapEnd,
        overlapStart,
        status,
        statusLabel,
      };
    });
  const selectedIncomeCents = orders.reduce((total, order) => total + amountCents(order.amount), 0);
  const weeklyIncludedCents = rows.reduce((total, row) => total + amountCents(row.includedAmount), 0);
  const missingOriginalCount = rows.filter((row) => row.status === "awaiting_original").length;
  const issueCount = rows.filter((row) => ["mismatch", "unreadable_total"].includes(row.status)).length;
  const differenceCents = selectedIncomeCents - weeklyIncludedCents;
  const overallStatus = differenceCents !== 0 || issueCount > 0
    ? "issue"
    : missingOriginalCount > 0 ? "awaiting_original" : "matched";
  return {
    difference: centsAmount(differenceCents),
    issueCount,
    missingOriginalCount,
    overallStatus,
    rows,
    selectedIncomeTotal: centsAmount(selectedIncomeCents),
    weeklyIncludedTotal: centsAmount(weeklyIncludedCents),
  };
}

const RECONCILIATION_COLUMNS = Object.freeze([
  { key: "period", label: "รอบ Weekly", width: 113 },
  { key: "shopLabel", label: "ร้าน", width: 78 },
  { key: "originalStatus", label: "ไฟล์ต้นฉบับ", width: 100 },
  { key: "orderCount", label: "ออเดอร์", width: 54, align: "right" },
  { key: "fullDocumentAmount", label: "ยอดเต็มเอกสาร", width: 102, align: "right" },
  { key: "includedAmount", label: "ยอดนับเข้าช่วง", width: 102, align: "right" },
  { key: "excludedAmount", label: "ยอดนอกช่วง", width: 102, align: "right" },
  { key: "statusLabel", label: "ผลตรวจ", width: 133 },
]);

function reconciliationFill(status) {
  if (status === "matched" || status === "partial_overlap") return COLORS.paleGreen;
  if (status === "awaiting_original") return COLORS.paleYellow;
  if (status === "excluded") return COLORS.paleGray;
  return COLORS.paleRed;
}

function reconciliationCellValue(row, key) {
  if (key === "period") return `${formatDate(row.document.startDate)} - ${formatDate(row.document.endDate)}`;
  if (key === "shopLabel") return row.document.shopLabel || row.document.shopCode;
  if (key === "originalStatus") return row.document.originalAvailable ? "มีไฟล์" : "ยังไม่มีไฟล์";
  if (["fullDocumentAmount", "includedAmount", "excludedAmount"].includes(key)) {
    return row[key] == null ? "-" : formatMoney(row[key]);
  }
  return row[key];
}

function drawWeeklyReconciliationPages(pdf, font, reconciliation, filters) {
  const chunks = [];
  if (!reconciliation.rows.length) chunks.push([]);
  for (let index = 0; index < reconciliation.rows.length; index += RECONCILIATION_ROWS_PER_PAGE) {
    chunks.push(reconciliation.rows.slice(index, index + RECONCILIATION_ROWS_PER_PAGE));
  }
  return chunks.map((chunk, pageIndex) => {
    const page = pdf.addPage(A4_LANDSCAPE);
    drawTitle(
      page,
      font,
      "สรุปการกระทบยอดรายสัปดาห์",
      `ยึดวันที่โอนชำระเงินสำเร็จ ${formatDate(filters.dateFrom)} ถึง ${formatDate(filters.dateTo)} | หน้า ${pageIndex + 1}/${chunks.length}`,
    );
    drawText(page, font, "ยอดเต็มเอกสารคือยอดทั้งสัปดาห์ ส่วนยอดนับเข้าช่วงใช้เฉพาะวันที่ที่เลือก เอกสาร monthly เป็นหลักฐานและไม่นำมานับซ้ำ", {
      color: COLORS.muted, maxWidth: 782, size: 11, x: 30, y: 505,
    });
    const tableX = 29;
    const headerY = 448;
    let x = tableX;
    RECONCILIATION_COLUMNS.forEach((column) => {
      page.drawRectangle({ x, y: headerY, width: column.width, height: 35, color: COLORS.blue });
      drawText(page, font, column.label, {
        align: "center", color: COLORS.white, maxWidth: column.width - 8, size: 9.5, x: x + 4, y: headerY + 12,
      });
      x += column.width;
    });
    if (!chunk.length) {
      drawText(page, font, "ไม่พบรายงานการเงินรายสัปดาห์ที่ทับซ้อนช่วงนี้", {
        align: "center", color: COLORS.muted, maxWidth: 784, size: 14, x: tableX, y: 406,
      });
    }
    chunk.forEach((row, rowIndex) => {
      const rowY = headerY - (rowIndex + 1) * 27;
      let cellX = tableX;
      RECONCILIATION_COLUMNS.forEach((column) => {
        page.drawRectangle({
          x: cellX,
          y: rowY,
          width: column.width,
          height: 27,
          borderColor: COLORS.border,
          borderWidth: 0.5,
          color: column.key === "statusLabel"
            ? reconciliationFill(row.status)
            : rowIndex % 2 ? rgb(248 / 255, 250 / 255, 252 / 255) : COLORS.white,
        });
        drawText(page, font, reconciliationCellValue(row, column.key), {
          align: column.align || "left", maxWidth: column.width - 8, size: 8.8, x: cellX + 4, y: rowY + 8,
        });
        cellX += column.width;
      });
    });
    if (pageIndex === chunks.length - 1) {
      const summaryY = 62;
      const summaryItems = [
        ["ยอด Income ตามช่วง", formatMoney(reconciliation.selectedIncomeTotal)],
        ["ยอด Weekly ที่นับเข้าช่วง", formatMoney(reconciliation.weeklyIncludedTotal)],
        ["ผลต่าง", formatMoney(reconciliation.difference)],
      ];
      summaryItems.forEach(([label, value], index) => {
        const boxX = 29 + index * 190;
        page.drawRectangle({ x: boxX, y: summaryY, width: 176, height: 48, color: COLORS.paleBlue, borderColor: COLORS.border, borderWidth: 0.7 });
        drawText(page, font, label, { color: COLORS.muted, maxWidth: 160, size: 9.5, x: boxX + 8, y: summaryY + 29 });
        drawText(page, font, value, { color: COLORS.blue, maxWidth: 160, size: 13, x: boxX + 8, y: summaryY + 10 });
      });
      const overallLabel = reconciliation.overallStatus === "matched"
        ? "หลักฐานครบและยอดตรง"
        : reconciliation.overallStatus === "awaiting_original"
          ? `ยอดตาม Income ครบ แต่รอไฟล์ต้นฉบับ ${reconciliation.missingOriginalCount} ฉบับ`
          : reconciliation.difference !== 0
            ? `ยอดรวมต่างกัน ${formatMoney(reconciliation.difference)}`
            : `ต้องตรวจสอบ ${reconciliation.issueCount} จุด`;
      page.drawRectangle({ x: 599, y: summaryY, width: 213, height: 48, color: reconciliationFill(reconciliation.overallStatus === "issue" ? "mismatch" : reconciliation.overallStatus) });
      drawText(page, font, "สถานะรวม", { color: COLORS.muted, maxWidth: 197, size: 9.5, x: 607, y: summaryY + 29 });
      drawText(page, font, overallLabel, { maxWidth: 197, size: 11, x: 607, y: summaryY + 10 });
    }
    return page;
  });
}

const INDEX_COLUMNS = Object.freeze([
  { key: "sequence", label: "ลำดับ", width: 38, align: "center" },
  { key: "kindLabel", label: "ประเภทเอกสาร", width: 134 },
  { key: "shopLabel", label: "ร้าน", width: 90 },
  { key: "period", label: "ช่วงวันที่", width: 148 },
  { key: "filename", label: "ชื่อไฟล์ต้นฉบับ", width: 272 },
  { key: "appendixStatus", label: "สถานะ/หน้าเริ่มต้น", width: 102 },
]);

function drawAppendixIndexPages(pdf, font, documents, skipped, startPageByDocument) {
  const rows = documents.map((document, index) => ({
    ...document,
    appendixAvailable: startPageByDocument.has(document),
    appendixStatus: startPageByDocument.has(document)
      ? `เริ่มหน้า ${startPageByDocument.get(document)}`
      : skipped.get(document) || (document.originalAvailable ? "ไม่มี PDF ให้แนบ" : "ขาดไฟล์ต้นฉบับ"),
    period: `${formatDate(document.startDate)} - ${formatDate(document.endDate)}`,
    sequence: index + 1,
  }));
  const chunks = [];
  if (!rows.length) chunks.push([]);
  for (let index = 0; index < rows.length; index += INDEX_ROWS_PER_PAGE) {
    chunks.push(rows.slice(index, index + INDEX_ROWS_PER_PAGE));
  }
  return chunks.map((chunk, pageIndex) => {
    const page = pdf.addPage(A4_LANDSCAPE);
    drawTitle(
      page,
      font,
      "ภาคผนวก - เอกสาร Shopee ต้นฉบับ",
      `ดัชนีหลักฐาน ${pageIndex + 1}/${chunks.length} | หน้าต้นฉบับถัดจากดัชนีนี้เป็นสำเนาจากไฟล์ที่เก็บไว้โดยตรง`,
    );
    const tableX = 29;
    const headerY = 486;
    let x = tableX;
    INDEX_COLUMNS.forEach((column) => {
      page.drawRectangle({ x, y: headerY, width: column.width, height: 35, color: COLORS.blue });
      drawText(page, font, column.label, {
        align: "center",
        color: COLORS.white,
        maxWidth: column.width - 8,
        size: 10,
        x: x + 4,
        y: headerY + 12,
      });
      x += column.width;
    });
    if (!chunk.length) {
      drawText(page, font, "ไม่พบเอกสาร Shopee ต้นฉบับในช่วงที่เลือก", {
        align: "center", color: COLORS.muted, maxWidth: 784, size: 14, x: tableX, y: 444,
      });
      return page;
    }
    chunk.forEach((row, rowIndex) => {
      const rowY = headerY - (rowIndex + 1) * 24;
      let cellX = tableX;
      INDEX_COLUMNS.forEach((column) => {
        const missing = !row.appendixAvailable;
        page.drawRectangle({
          x: cellX,
          y: rowY,
          width: column.width,
          height: 24,
          borderColor: COLORS.border,
          borderWidth: 0.5,
          color: missing && column.key === "appendixStatus"
            ? rgb(1, 244 / 255, 204 / 255)
            : rowIndex % 2 ? rgb(248 / 255, 250 / 255, 252 / 255) : COLORS.white,
        });
        drawText(page, font, row[column.key], {
          align: column.align || "left",
          maxWidth: column.width - 8,
          size: 9.5,
          x: cellX + 4,
          y: rowY + 7,
        });
        cellX += column.width;
      });
    });
    return page;
  });
}

async function buildAccountingIncomeCombinedPdf({
  documents = [],
  filters,
  orders = [],
  sourcePolicy,
  storage,
  summary,
}) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(await fs.readFile(FONT_PATH), { subset: true });
  pdf.setCreator("ClaspSCxSeamless");
  pdf.setTitle("Shopee Income accounting report with original appendices");
  pdf.setSubject("Income rows and original Shopee financial statement appendices");

  const { entries, skipped } = await loadAppendixEntries(documents, storage);
  const reconciliation = buildWeeklyReconciliation({ documents, entries, filters, orders });
  const generatedPages = [];
  generatedPages.push(drawCover(pdf, font, {
    documents, filters, orders, sourcePolicy, summary,
  }));
  generatedPages.push(...drawOrderPages(pdf, font, { filters, orders }));
  generatedPages.push(...drawWeeklyReconciliationPages(pdf, font, reconciliation, filters));

  const indexPageCount = Math.max(1, Math.ceil(documents.length / INDEX_ROWS_PER_PAGE));
  const startPageByDocument = new Map();
  let nextPage = generatedPages.length + indexPageCount + 1;
  for (const entry of entries) {
    startPageByDocument.set(entry.document, nextPage);
    nextPage += entry.pageCount;
  }
  generatedPages.push(...drawAppendixIndexPages(
    pdf,
    font,
    documents,
    skipped,
    startPageByDocument,
  ));

  for (const entry of entries) {
    const copiedPages = await pdf.copyPages(entry.sourcePdf, entry.sourcePdf.getPageIndices());
    copiedPages.forEach((page) => pdf.addPage(page));
  }
  const totalPages = pdf.getPageCount();
  generatedPages.forEach((page, index) => drawFooter(page, font, index + 1, totalPages));
  return Buffer.from(await pdf.save());
}

module.exports = {
  A4_LANDSCAPE,
  INDEX_ROWS_PER_PAGE,
  MAX_APPENDIX_BYTES,
  MAX_APPENDIX_PAGES,
  ORDER_ROWS_PER_PAGE,
  RECONCILIATION_ROWS_PER_PAGE,
  buildAccountingIncomeCombinedPdf,
  buildWeeklyReconciliation,
  fitText,
  formatDate,
  formatMoney,
};
