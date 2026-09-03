const {
  getVerifiedMatchedUnitsPerSale,
} = require("./shopeeProductMatcher");
const {
  packagingQuantitiesForRecord,
} = require("./shopeeAutomaticQuantityRules");

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const EXPORT_COLUMNS = Object.freeze([
  { header: "วันที่ เวลา", key: "orderedAt", width: 22 },
  { header: "เลขออเดอร์", key: "orderNumber", width: 22 },
  { header: "เลข SKU บริษัท", key: "companySku", width: 20 },
  { header: "ชื่อสินค้า", key: "productName", width: 70 },
  { header: "จำนวนสินค้า (หน่วยที่เล็กสุด)", key: "quantity", width: 24 },
  { header: "หน่วย", key: "unit", width: 20 },
]);

const QUANTITY_UNIT_LABELS = Object.freeze({
  bar: "ก้อน",
  blister: "แผง",
  box: "กล่อง",
  can: "กระป๋อง",
  jar: "กระปุก",
  pack: "แพ็ก",
  piece: "ชิ้น",
  sachet: "ซอง",
});

const BANGKOK_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  month: "2-digit",
  second: "2-digit",
  timeZone: "Asia/Bangkok",
  year: "numeric",
});

function normalizeListingQuantity(value) {
  const quantity = Number(value);
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null;
}

function toBangkokExcelDate(value) {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = Object.fromEntries(BANGKOK_DATE_TIME_FORMATTER
    .formatToParts(instant)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
  return new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  ));
}

function formatExportProductName(item) {
  const name = String(item?.name || "").trim() || "ไม่ทราบชื่อสินค้า";
  const variant = String(item?.variant || "").trim();
  return variant ? `${name} — ${variant}` : name;
}

function inferExplicitSingleUnit(item) {
  const quantitiesByUnit = packagingQuantitiesForRecord({
    productName: item?.name,
    variant: item?.variant,
  });
  const unitCandidates = [...quantitiesByUnit.entries()]
    .filter(([, quantities]) => quantities.size === 1 && quantities.has(1))
    .map(([unit]) => unit);
  return unitCandidates.length === 1 ? unitCandidates[0] : null;
}

function resolveExportUnit(item, productMatch) {
  const quantityUnit = productMatch?.quantityUnit || inferExplicitSingleUnit(item);
  return QUANTITY_UNIT_LABELS[quantityUnit] || "หน่วยฐาน SKU";
}

function createBaseRow(order, item, overrides = {}) {
  return {
    companySku: overrides.companySku || "-",
    orderNumber: String(order?.orderNumber || "").trim(),
    orderedAt: toBangkokExcelDate(order?.orderedAt),
    productName: formatExportProductName(item),
    quantity: overrides.quantity ?? normalizeListingQuantity(item?.quantity),
    unit: overrides.unit || "หน่วยฐาน SKU",
  };
}

function buildReviewRow(order, item, reason) {
  const productMatch = item?.productMatch;
  const companySkus = productMatch?.status === "bundle"
    ? (productMatch.components || []).map((component) => component?.companySku).filter(Boolean)
    : [productMatch?.companySku].filter(Boolean);
  return {
    ...createBaseRow(order, item, {
      companySku: companySkus.join(", ") || "-",
      unit: "ชุดขาย (รอตรวจสอบ)",
    }),
    reason,
  };
}

function rowsForOrderItem(order, item) {
  const listingQuantity = normalizeListingQuantity(item?.quantity);
  if (!listingQuantity) {
    return {
      readyRows: [],
      reviewRows: [buildReviewRow(order, item, "จำนวนสินค้าในออเดอร์ไม่ถูกต้อง")],
    };
  }

  const productMatch = item?.productMatch;
  if (productMatch?.status === "matched" && productMatch.companySku) {
    if (productMatch.quantityRuleStatus === "requires_validation") {
      return {
        readyRows: [],
        reviewRows: [buildReviewRow(order, item, "ยังไม่ยืนยันตัวคูณและหน่วยฐานของแพ็กสินค้า")],
      };
    }
    const unitsPerSale = getVerifiedMatchedUnitsPerSale(productMatch) || 1;
    return {
      readyRows: [createBaseRow(order, item, {
        companySku: productMatch.companySku,
        quantity: listingQuantity * unitsPerSale,
        unit: resolveExportUnit(item, productMatch),
      })],
      reviewRows: [],
    };
  }

  if (productMatch?.status === "bundle") {
    const components = Array.isArray(productMatch.components) ? productMatch.components : [];
    const isVerified = productMatch.quantityRuleStatus === "verified"
      && components.length > 0
      && components.every((component) => (
        String(component?.companySku || "").trim()
        && Number.isSafeInteger(component?.quantityPerSale)
        && component.quantityPerSale > 0
      ));
    if (!isVerified) {
      return {
        readyRows: [],
        reviewRows: [buildReviewRow(order, item, "Bundle ยังไม่ยืนยัน SKU หรือจำนวนหน่วยต่อชุด")],
      };
    }
    const unit = resolveExportUnit(item, productMatch);
    return {
      readyRows: components.map((component) => createBaseRow(order, item, {
        companySku: component.companySku,
        quantity: listingQuantity * component.quantityPerSale,
        unit,
      })),
      reviewRows: [],
    };
  }

  return {
    readyRows: [],
    reviewRows: [buildReviewRow(order, item, "ยังจับคู่ Company SKU ไม่สำเร็จ")],
  };
}

function rowIdentity(row) {
  return JSON.stringify([
    row.orderedAt?.toISOString() || "",
    row.orderNumber,
    row.companySku,
    row.productName,
    row.unit,
    row.reason || "",
  ]);
}

function aggregateRows(rows) {
  const byIdentity = new Map();
  rows.forEach((row) => {
    const key = rowIdentity(row);
    const existing = byIdentity.get(key);
    if (existing && Number.isFinite(existing.quantity) && Number.isFinite(row.quantity)) {
      existing.quantity += row.quantity;
    } else if (!existing) {
      byIdentity.set(key, { ...row });
    }
  });
  return [...byIdentity.values()].sort((left, right) => (
    (left.orderedAt?.getTime() || 0) - (right.orderedAt?.getTime() || 0)
      || left.orderNumber.localeCompare(right.orderNumber)
      || left.companySku.localeCompare(right.companySku)
      || left.productName.localeCompare(right.productName, "th")
  ));
}

function buildShopeeSalesExportRows(orders = []) {
  const readyRows = [];
  const reviewRows = [];
  orders.forEach((order) => {
    (Array.isArray(order?.items) ? order.items : []).forEach((item) => {
      const itemRows = rowsForOrderItem(order, item);
      readyRows.push(...itemRows.readyRows);
      reviewRows.push(...itemRows.reviewRows);
    });
  });
  return {
    readyRows: aggregateRows(readyRows),
    reviewRows: aggregateRows(reviewRows),
  };
}

function styleWorksheet(worksheet, { review = false } = {}) {
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: worksheet.columnCount },
  };
  worksheet.getRow(1).height = 24;
  worksheet.getRow(1).eachCell((cell) => {
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: review ? "FFF4B183" : "FF1F4E78" },
    };
    cell.font = { bold: true, color: { argb: review ? "FF3F2500" : "FFFFFFFF" } };
  });
  worksheet.getColumn("orderedAt").numFmt = "yyyy-mm-dd hh:mm:ss";
  worksheet.getColumn("orderNumber").numFmt = "@";
  worksheet.getColumn("companySku").numFmt = "@";
  worksheet.getColumn("quantity").numFmt = "0";
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.alignment = { vertical: "top", wrapText: true };
  });
}

function addWorksheet(workbook, name, rows, { review = false } = {}) {
  const worksheet = workbook.addWorksheet(name);
  worksheet.columns = [
    ...EXPORT_COLUMNS,
    ...(review ? [{ header: "เหตุผลที่ต้องตรวจสอบ", key: "reason", width: 44 }] : []),
  ];
  rows.forEach((row) => worksheet.addRow(row));
  styleWorksheet(worksheet, { review });
  return worksheet;
}

async function buildShopeeSalesExportWorkbook(orders = []) {
  // Keep the relatively heavy XLSX dependency off the normal JSON summary request path.
  // eslint-disable-next-line global-require
  const ExcelJS = require("exceljs");
  const { readyRows, reviewRows } = buildShopeeSalesExportRows(orders);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "SC Drug Store";
  workbook.created = new Date();
  workbook.modified = new Date();
  addWorksheet(workbook, "พร้อมคีย์", readyRows);
  if (reviewRows.length) addWorksheet(workbook, "ต้องตรวจสอบ", reviewRows, { review: true });
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    readyRowCount: readyRows.length,
    reviewRowCount: reviewRows.length,
  };
}

function buildShopeeSalesExportFilename({ endDate, shopCode, startDate }) {
  const shopSegment = String(shopCode || "all").replace(/[^a-z0-9-]+/giu, "-");
  return `shopee-sales-${shopSegment}-${startDate}-to-${endDate}.xlsx`;
}

async function exportShopeeSalesSummary({ endDate, shopCode, startDate }) {
  // Lazy loading also lets pure export-row tests run without initializing the production DB.
  // eslint-disable-next-line global-require
  const repository = require("../db/shopeeOrderRepository");
  const orders = await repository.listOrdersForSalesSummary({ endDate, shopCode, startDate });
  return {
    ...await buildShopeeSalesExportWorkbook(orders),
    filename: buildShopeeSalesExportFilename({ endDate, shopCode, startDate }),
    mimeType: XLSX_MIME_TYPE,
  };
}

module.exports = {
  EXPORT_COLUMNS,
  XLSX_MIME_TYPE,
  buildShopeeSalesExportFilename,
  buildShopeeSalesExportRows,
  buildShopeeSalesExportWorkbook,
  exportShopeeSalesSummary,
  formatExportProductName,
  resolveExportUnit,
  toBangkokExcelDate,
};
