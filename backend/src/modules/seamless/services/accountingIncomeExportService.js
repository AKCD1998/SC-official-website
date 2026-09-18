const repository = require("../db/accountingIncomeOrderRepository");

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const EXPORT_PAGE_SIZE = 1000;
const MAX_EXPORT_ROWS = 20000;
const STATUS_LABELS = Object.freeze({
  amount_mismatch: "พบข้อมูลแต่ยอดไม่ตรง",
  credited: "เงินเข้าแล้ว",
  not_covered: "ยังไม่มีรายงานครอบคลุม",
  not_found_in_covered_report: "รายงานครอบคลุม แต่ไม่พบ",
  outflow_or_reversed: "มีเงินออกหรือย้อนรายการ",
});
const SHOP_LABELS = Object.freeze({
  "dr-morepen": "DR.Morepen",
  "sc-drug-store": "SC Drug Store",
});
const KIND_LABELS = Object.freeze({
  income: "รายงานรายรับของฉัน",
  statement: "รายงานการเงิน",
});

function shopLabel(shopCode) {
  return SHOP_LABELS[shopCode] || "ทุกร้าน";
}

function toExcelDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value || ""))) return null;
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDateLabel(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value || ""))) return String(value || "");
  const [year, month, day] = String(value).split("-");
  return `${day}/${month}/${year}`;
}

function absoluteOriginalUrl(publicOrigin, originalPath) {
  if (!originalPath || !/^https?:\/\//iu.test(String(publicOrigin || ""))) return null;
  return `${String(publicOrigin).replace(/\/+$/u, "")}/api${originalPath}`;
}

function styleSectionRow(row, columnCount) {
  row.height = 23;
  for (let column = 1; column <= columnCount; column += 1) {
    const cell = row.getCell(column);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9EAF7" } };
    cell.font = { bold: true, color: { argb: "FF17365D" }, name: "Arial", size: 10 };
    cell.alignment = { vertical: "middle" };
  }
}

function styleHeaderRow(row, { fill = "FF1F4E78" } = {}) {
  row.height = 32;
  row.eachCell((cell) => {
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Arial", size: 10 };
    cell.border = {
      bottom: { style: "thin", color: { argb: "FFFFFFFF" } },
      right: { style: "thin", color: { argb: "FFFFFFFF" } },
    };
  });
}

function applyPageSetup(worksheet, printTitlesRow) {
  worksheet.pageSetup = {
    fitToHeight: 0,
    fitToPage: true,
    fitToWidth: 1,
    margins: { bottom: 0.35, footer: 0.15, header: 0.15, left: 0.25, right: 0.25, top: 0.35 },
    orientation: "landscape",
    paperSize: 9,
    printTitlesRow,
  };
  worksheet.headerFooter = {
    oddFooter: "&Lชุดข้อมูลรายรับสำหรับบัญชี&Cหน้า &P จาก &N&Rวันที่พิมพ์ &D",
  };
}

function addSourceDocumentSheet(workbook, {
  documents,
  filters,
  orders,
  publicOrigin,
}) {
  const worksheet = workbook.addWorksheet("เอกสารต้นฉบับ");
  worksheet.columns = [
    { width: 22 },
    { width: 19 },
    { width: 19 },
    { width: 19 },
    { width: 48 },
    { width: 23 },
    { width: 20 },
  ];

  worksheet.mergeCells("A2:G2");
  worksheet.getCell("A2").value = "ชุดข้อมูลรายรับสำหรับบัญชี";
  worksheet.getCell("A2").font = { bold: true, color: { argb: "FF17365D" }, name: "Arial", size: 15 };
  worksheet.getCell("A2").alignment = { vertical: "middle" };
  worksheet.getRow(2).height = 27;

  const metadata = [
    ["ช่วงวันที่ที่เลือก", toExcelDate(filters.dateFrom), "ถึง", toExcelDate(filters.dateTo)],
    ["ฐานวันที่", "วันที่โอนชำระเงินสำเร็จ", null, null],
    ["ความหมาย", "รวมออเดอร์ที่ Shopee ทำรายการโอนชำระเงินสำเร็จในช่วงนี้ ไม่ใช่วันที่สั่งซื้อหรือวันที่กดดาวน์โหลด", null, null],
    ["เขตเวลา", "Asia/Bangkok", null, null],
    ["ร้านที่เลือก", shopLabel(filters.shopCode), null, null],
    ["เลขคำสั่งซื้อ", filters.orderNumber || "ทั้งหมด", null, null],
  ];
  metadata.forEach((values, index) => {
    const rowNumber = index + 4;
    const row = worksheet.getRow(rowNumber);
    row.getCell(1).value = values[0];
    row.getCell(1).font = { bold: true, name: "Arial", size: 10 };
    row.getCell(2).value = values[1];
    row.getCell(3).value = values[2];
    row.getCell(4).value = values[3];
    if (rowNumber !== 4) worksheet.mergeCells(rowNumber, 2, rowNumber, 7);
    row.alignment = { vertical: "middle", wrapText: true };
    row.font = { ...row.font, name: "Arial", size: 10 };
  });
  worksheet.getRow(6).height = 34;
  worksheet.getCell("B4").numFmt = "dd/mm/yyyy";
  worksheet.getCell("D4").numFmt = "dd/mm/yyyy";

  const totalIncome = orders.reduce((sum, order) => sum + Number(order.amount || 0), 0);
  const creditedCount = orders.filter((order) => order.sellerBalanceStatus === "credited").length;
  worksheet.mergeCells("A10:G10");
  worksheet.getCell("A10").value = "สรุปรายการที่ส่งออก";
  styleSectionRow(worksheet.getRow(10), 7);
  worksheet.getRow(11).values = [
    "จำนวนรายการ", orders.length,
    "ยอด Income รวม (บาท)", totalIncome,
    "เงินเข้า Seller Balance แล้ว", creditedCount,
  ];
  worksheet.getRow(11).alignment = { vertical: "middle", wrapText: true };
  [1, 3, 5].forEach((column) => {
    const cell = worksheet.getRow(11).getCell(column);
    cell.font = { bold: true, name: "Arial", size: 10, color: { argb: "FF1F4E78" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF2F8" } };
  });
  [2, 4, 6].forEach((column) => {
    worksheet.getRow(11).getCell(column).alignment = { horizontal: "right", vertical: "middle" };
  });
  for (let column = 1; column <= 6; column += 1) {
    worksheet.getRow(11).getCell(column).border = {
      bottom: { style: "thin", color: { argb: "FFB4C7DC" } },
      left: { style: "thin", color: { argb: "FFD9E2F3" } },
      right: { style: "thin", color: { argb: "FFD9E2F3" } },
      top: { style: "thin", color: { argb: "FFB4C7DC" } },
    };
  }
  worksheet.getRow(11).height = 24;
  worksheet.getCell("D11").numFmt = "#,##0.00;[Red](#,##0.00);-";

  worksheet.mergeCells("A13:G13");
  worksheet.getCell("A13").value = "เอกสาร Shopee ต้นฉบับที่อ้างอิง";
  styleSectionRow(worksheet.getRow(13), 7);
  worksheet.mergeCells("A14:G14");
  worksheet.getCell("A14").value = "ไฟล์ต้นฉบับคงสภาพเดิมและเปิดผ่านลิงก์ด้านล่าง รายงานการเงิน PDF จะไม่ถูกแปลงหรือฝังลงใน Excel";
  worksheet.getCell("A14").font = { italic: true, color: { argb: "FF666666" }, name: "Arial", size: 9 };
  worksheet.getCell("A14").alignment = { vertical: "middle", wrapText: true };
  worksheet.getRow(14).height = 30;

  const headerRow = worksheet.getRow(15);
  headerRow.values = ["ประเภทเอกสาร", "ร้าน", "จากวันที่", "ถึงวันที่", "ชื่อไฟล์ต้นฉบับ", "สถานะไฟล์", "เปิดเอกสารต้นฉบับ"];
  styleHeaderRow(headerRow);

  if (!documents.length) {
    worksheet.mergeCells("A16:G16");
    worksheet.getCell("A16").value = "ไม่พบเอกสารต้นฉบับหรือข้อมูลแหล่งที่มาที่ครอบคลุมช่วงวันที่นี้";
    worksheet.getCell("A16").alignment = { horizontal: "center", vertical: "middle" };
    worksheet.getCell("A16").font = { color: { argb: "FF9C6500" }, name: "Arial", size: 10 };
  } else {
    documents.forEach((document, index) => {
      const row = worksheet.getRow(16 + index);
      row.values = [
        KIND_LABELS[document.kind] || document.kind,
        SHOP_LABELS[document.shopCode] || document.shopCode,
        toExcelDate(document.startDate),
        toExcelDate(document.endDate),
        document.filename,
        document.originalAvailable ? "มีไฟล์ต้นฉบับในเว็บ" : "ระบบเก็บเฉพาะข้อมูลที่อ่านได้",
        document.originalAvailable ? "ดาวน์โหลดต้นฉบับ" : "ไม่มีไฟล์ให้ดาวน์โหลด",
      ];
      row.getCell(3).numFmt = "dd/mm/yyyy";
      row.getCell(4).numFmt = "dd/mm/yyyy";
      row.getCell(5).note = `SHA-256: ${document.checksumSha256}`;
      const url = absoluteOriginalUrl(publicOrigin, document.originalPath);
      if (url) {
        row.getCell(7).value = { hyperlink: url, text: "ดาวน์โหลดต้นฉบับ" };
        row.getCell(7).font = { color: { argb: "FF0563C1" }, name: "Arial", size: 10, underline: true };
      }
      row.alignment = { vertical: "top", wrapText: true };
      row.font = { ...row.font, name: "Arial", size: 10 };
      row.height = 30;
    });
  }

  worksheet.autoFilter = {
    from: { column: 1, row: 15 },
    to: { column: 7, row: 15 + Math.max(1, documents.length) },
  };
  worksheet.views = [{ showGridLines: false, state: "frozen", ySplit: 15 }];
  applyPageSetup(worksheet, "15:15");
  return worksheet;
}

function addIncomeOrdersSheet(workbook, { filters, orders }) {
  const worksheet = workbook.addWorksheet("รายการรายรับ");
  worksheet.columns = [
    { key: "orderNumber", width: 22 },
    { key: "shop", width: 18 },
    { key: "orderDate", width: 18 },
    { key: "transferDate", width: 23 },
    { key: "amount", width: 21 },
    { key: "sellerBalanceStatus", width: 30 },
    { key: "sellerBalanceInflowDate", width: 25 },
    { key: "sellerBalanceNetAmount", width: 23 },
  ];
  worksheet.mergeCells("A1:H1");
  worksheet.getCell("A1").value = "รายการรายรับจาก Income";
  worksheet.getCell("A1").font = { bold: true, color: { argb: "FF17365D" }, name: "Arial", size: 14 };
  worksheet.getRow(1).height = 26;
  worksheet.mergeCells("A2:H2");
  worksheet.getCell("A2").value = `ร้าน ${shopLabel(filters.shopCode)} | ช่วงวันที่โอนชำระเงินสำเร็จ ${formatDateLabel(filters.dateFrom)} ถึง ${formatDateLabel(filters.dateTo)} (Asia/Bangkok)`;
  worksheet.getCell("A2").font = { italic: true, color: { argb: "FF666666" }, name: "Arial", size: 10 };

  const headerRow = worksheet.getRow(4);
  headerRow.values = [
    "หมายเลขคำสั่งซื้อ",
    "ร้าน",
    "วันที่ทำการสั่งซื้อ",
    "วันที่โอนชำระเงินสำเร็จ",
    "จำนวนเงินทั้งหมดที่โอนแล้ว (บาท)",
    "สถานะ Seller Balance",
    "วันที่เงินเข้า Seller Balance",
    "ยอดสุทธิ Seller Balance (บาท)",
  ];
  styleHeaderRow(headerRow);

  orders.forEach((order, index) => {
    const row = worksheet.getRow(index + 5);
    row.values = [
      order.orderNumber,
      shopLabel(order.shopCode),
      toExcelDate(order.orderDate),
      toExcelDate(order.transferDate),
      Number(order.amount),
      STATUS_LABELS[order.sellerBalanceStatus] || "ไม่ทราบสถานะ",
      toExcelDate(order.sellerBalanceInflowDate),
      order.sellerBalanceNetAmount === null || order.sellerBalanceNetAmount === undefined
        ? null
        : Number(order.sellerBalanceNetAmount),
    ];
    row.getCell(1).numFmt = "@";
    [3, 4, 7].forEach((column) => { row.getCell(column).numFmt = "dd/mm/yyyy"; });
    [5, 8].forEach((column) => { row.getCell(column).numFmt = "#,##0.00;[Red](#,##0.00);-"; });
    row.alignment = { vertical: "middle", wrapText: true };
    row.font = { name: "Arial", size: 10 };
    const statusCell = row.getCell(6);
    const statusColors = {
      credited: ["FFE2F0D9", "FF375623"],
      outflow_or_reversed: ["FFF4CCCC", "FF9C0006"],
      amount_mismatch: ["FFFFE699", "FF7F6000"],
      not_found_in_covered_report: ["FFFFE699", "FF7F6000"],
      not_covered: ["FFE7E6E6", "FF595959"],
    };
    const colors = statusColors[order.sellerBalanceStatus];
    if (colors) {
      statusCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colors[0] } };
      statusCell.font = { bold: true, color: { argb: colors[1] }, name: "Arial", size: 10 };
    }
  });

  const lastRow = Math.max(4, orders.length + 4);
  worksheet.autoFilter = { from: { column: 1, row: 4 }, to: { column: 8, row: lastRow } };
  worksheet.views = [{ showGridLines: false, state: "frozen", ySplit: 4 }];
  applyPageSetup(worksheet, "4:4");
  return worksheet;
}

async function buildAccountingIncomeExportWorkbook({
  documents = [],
  filters,
  orders = [],
  publicOrigin = "",
}) {
  // Lazy loading keeps ExcelJS off the normal paginated JSON request path.
  // eslint-disable-next-line global-require
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ClaspSCxSeamless";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.title = "Shopee Income accounting export";
  addSourceDocumentSheet(workbook, { documents, filters, orders, publicOrigin });
  addIncomeOrdersSheet(workbook, { filters, orders });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function buildAccountingIncomeExportFilename({ dateFrom, dateTo, shopCode }) {
  const shopPart = shopCode ? `-${shopCode}` : "";
  return `shopee-income-accounting${shopPart}-${dateFrom}-to-${dateTo}.xlsx`;
}

async function collectAllIncomeOrders(filters, incomeRepository = repository) {
  const first = await incomeRepository.listIncomeOrders({
    ...filters,
    page: 1,
    pageSize: EXPORT_PAGE_SIZE,
  });
  if (first.totalCount > MAX_EXPORT_ROWS) {
    const error = new Error(`Income export exceeds the ${MAX_EXPORT_ROWS.toLocaleString("en-US")} row limit.`);
    error.statusCode = 413;
    throw error;
  }
  const orders = [...first.orders];
  const totalPages = Math.ceil(first.totalCount / EXPORT_PAGE_SIZE);
  for (let page = 2; page <= totalPages; page += 1) {
    const next = await incomeRepository.listIncomeOrders({
      ...filters,
      page,
      pageSize: EXPORT_PAGE_SIZE,
    });
    orders.push(...next.orders);
  }
  return orders;
}

async function loadAccountingIncomeExportData(filters, incomeRepository = repository) {
  const [orders, documents] = await Promise.all([
    collectAllIncomeOrders(filters, incomeRepository),
    incomeRepository.listIncomeExportSourceDocuments({
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      shopCode: filters.shopCode,
    }),
  ]);
  return { documents, orders };
}

function buildAccountingIncomeExportPreview({
  documents = [],
  filters,
  orders = [],
  publicOrigin = "",
}) {
  const totalIncome = orders.reduce((sum, order) => sum + Number(order.amount || 0), 0);
  const creditedOrders = orders.filter((order) => order.sellerBalanceStatus === "credited");
  return {
    documents: documents.map((document) => ({
      endDate: document.endDate,
      filename: document.filename,
      kind: document.kind,
      kindLabel: KIND_LABELS[document.kind] || document.kind,
      originalAvailable: document.originalAvailable,
      originalUrl: absoluteOriginalUrl(publicOrigin, document.originalPath),
      shopCode: document.shopCode,
      shopLabel: shopLabel(document.shopCode),
      startDate: document.startDate,
    })),
    filters: {
      dateColumn: filters.dateColumn,
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      orderNumber: filters.orderNumber,
      shopCode: filters.shopCode,
      shopLabel: shopLabel(filters.shopCode),
    },
    orders: orders.map((order) => ({
      ...order,
      sellerBalanceStatusLabel: STATUS_LABELS[order.sellerBalanceStatus] || "ไม่ทราบสถานะ",
      shopLabel: shopLabel(order.shopCode),
    })),
    summary: {
      creditedCount: creditedOrders.length,
      orderCount: orders.length,
      totalIncome,
    },
    timezone: "Asia/Bangkok",
  };
}

async function previewAccountingIncomeOrders(filters, {
  incomeRepository = repository,
  publicOrigin = "",
} = {}) {
  const { documents, orders } = await loadAccountingIncomeExportData(filters, incomeRepository);
  return buildAccountingIncomeExportPreview({
    documents,
    filters,
    orders,
    publicOrigin,
  });
}

async function exportAccountingIncomeOrders(filters, {
  incomeRepository = repository,
  publicOrigin = "",
} = {}) {
  const { documents, orders } = await loadAccountingIncomeExportData(filters, incomeRepository);
  return {
    buffer: await buildAccountingIncomeExportWorkbook({
      documents,
      filters,
      orders,
      publicOrigin,
    }),
    filename: buildAccountingIncomeExportFilename(filters),
    mimeType: XLSX_MIME_TYPE,
  };
}

module.exports = {
  EXPORT_PAGE_SIZE,
  KIND_LABELS,
  MAX_EXPORT_ROWS,
  SHOP_LABELS,
  STATUS_LABELS,
  XLSX_MIME_TYPE,
  buildAccountingIncomeExportFilename,
  buildAccountingIncomeExportPreview,
  buildAccountingIncomeExportWorkbook,
  collectAllIncomeOrders,
  exportAccountingIncomeOrders,
  formatDateLabel,
  loadAccountingIncomeExportData,
  previewAccountingIncomeOrders,
  shopLabel,
  toExcelDate,
};
