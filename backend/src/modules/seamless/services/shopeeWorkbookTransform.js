const ExcelJS = require('exceljs');
const { badRequest } = require('../errors');
const { resolveCycleProfile } = require('./shopeeAccountingCycles');
const { applyDefaultFont, DEFAULT_FONT } = require('./xlsxDefaultFont');

// ---------------------------------------------------------------------------
// Header contract
// ---------------------------------------------------------------------------
// These literals are the exact source-column headers from a Shopee Order export
// (sheet `orders`). Header resolution is exact-string after normalization, so a single
// character drift must surface as a fail-closed error rather than a silent wrong column.
// The 12 entries below are the REQUIRED set for the DR.Morepen accounting mapping; PII
// headers (buyer/recipient/phone/address) are excluded from output but are not required.

const SOURCE_HEADERS = {
  orderNumber: 'หมายเลขคำสั่งซื้อ', // Raw A -> output A (text)
  status: 'สถานะการสั่งซื้อ', // Raw B -> output G
  orderDate: 'วันที่ทำการสั่งซื้อ', // Raw G -> output B (Date)
  productName: 'ชื่อสินค้า', // Raw S -> output C
  sku: 'เลขอ้างอิง SKU (SKU Reference No.)', // Raw T -> output E (text)
  variation: 'ชื่อตัวเลือก', // Raw U -> output D
  quantity: 'จำนวน', // Raw X -> output F
  netSale: 'ราคาขายสุทธิ', // Raw Z -> output H
  sellerVoucher: 'โค้ดส่วนลดชำระโดยผู้ขาย', // Raw AB -> output I
  commission: 'ค่าคอมมิชชั่น', // Raw AM -> output J
  transactionFee: 'Transaction Fee', // Raw AN -> output K
  completedAt: 'เวลาที่ทำการสั่งซื้อสำเร็จ', // Raw BF -> output M (Date)
};

const REQUIRED_HEADERS = Object.values(SOURCE_HEADERS);

const EXCLUDED_PII_HEADERS = [
  'ชื่อผู้ใช้ (ผู้ซื้อ)',
  'ชื่อผู้รับ',
  'หมายเลขโทรศัพท์',
  'ที่อยู่ในการจัดส่ง',
  'จังหวัด',
  'เขต/อำเภอ',
  'รหัสไปรษณีย์',
];

// Output A:M headers (spec §5). The I/J/K headers are multi-line in the spec; ExcelJS renders
// a string with embedded newlines as a wrapped cell, and wrapText is enabled on those columns.
const OUTPUT_HEADERS = [
  'หมายเลขคำสั่งซื้อ',
  'วันที่ทำการสั่งซื้อ',
  'ชื่อสินค้า',
  'ชื่อตัวเลือก',
  'เลขอ้างอิง',
  'จำนวน',
  'สถานะการสั่งซื้อ',
  'ราคาขายสุทธิ',
  'โค้ดส่วนลด ชำระโดยผู้ขาย',
  'ค่าคอมมิชชั่น',
  'Transaction Fee',
  'รายได้สุทธิ',
  'เวลาที่ทำการสั่งซื้อสำเร็จ',
];

const FONT = { name: 'Angsana New', size: 14, bold: false };
const ALIGNMENT = { horizontal: 'center', vertical: 'center' };

// ---------------------------------------------------------------------------
// Text/value normalization helpers (reused from the prior implementation)
// ---------------------------------------------------------------------------

function normalizeText(value) {
  if (value === null || typeof value === 'undefined') {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') {
      return value.text.trim();
    }
    if (Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text || '').join('').trim();
    }
    if (Object.prototype.hasOwnProperty.call(value, 'result')) {
      return normalizeText(value.result);
    }
  }
  return String(value).trim();
}

function normalizeHeader(value) {
  return normalizeText(value).replace(/\s+/g, ' ').trim();
}

function findShopeeHeader(worksheet) {
  for (let rowNumber = 1; rowNumber <= Math.min(worksheet.rowCount || 1, 20); rowNumber += 1) {
    const indexes = new Map();
    worksheet.getRow(rowNumber).eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      const header = normalizeHeader(cell.value);
      if (header && !indexes.has(header)) {
        indexes.set(header, columnNumber);
      }
    });
    if (REQUIRED_HEADERS.every((header) => indexes.has(header))) {
      return { rowNumber, indexes };
    }
  }
  return null;
}

function isShopeeWorksheet(worksheet) {
  return !!findShopeeHeader(worksheet);
}

function parseNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const normalized = normalizeText(value).replace(/,/g, '');
  if (!normalized || normalized === '-') {
    return 0;
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDateTime(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(value.getTime());
  }
  const normalized = normalizeText(value);
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  const second = Number(match[6] || 0);
  // Construct with Date.UTC so the wall-clock value written into the Date is the same one
  // ExcelJS's OOXML serializer embeds as the <v> serial. ExcelJS serializes via UTC getters,
  // so building with local getters (new Date(y,m,d,h,...)) introduces a tz-dependent shift on
  // write — on UTC+7 every serialized date landed 7 hours early in the file. Validating with
  // the matching UTC getters keeps the sanity check correct.
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute
  ) {
    return null;
  }
  return parsed;
}

function dateKey(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return '';
  }
  // parseDateTime deliberately stores the source wall clock in UTC fields for stable XLSX
  // serialization. Read the same UTC fields here so a host timezone cannot shift the fill date.
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseFilenamePeriod(filename) {
  const match = String(filename || '').match(/(\d{4})(\d{2})(\d{2})[_-](\d{4})(\d{2})(\d{2})/);
  if (!match) {
    return null;
  }
  const periodStart = `${match[1]}-${match[2]}-${match[3]}`;
  const periodEnd = `${match[4]}-${match[5]}-${match[6]}`;
  if (!parseDateTime(periodStart) || !parseDateTime(periodEnd) || periodStart > periodEnd) {
    return null;
  }
  return { periodStart, periodEnd };
}

// Exact decimal arithmetic helper: round to 2 decimal places without floating-point drift.
function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Row reading + typing
// ---------------------------------------------------------------------------

function readSourceRows(worksheet, header, warnings) {
  const columns = {};
  Object.entries(SOURCE_HEADERS).forEach(([key, label]) => {
    columns[key] = header.indexes.get(label) || null;
  });

  const rows = [];
  const invalidNumericCells = [];

  for (let rowNumber = header.rowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const get = (key) => {
      const columnNumber = columns[key];
      return columnNumber ? worksheet.getRow(rowNumber).getCell(columnNumber).value : null;
    };
    const orderNumber = normalizeText(get('orderNumber'));
    if (!orderNumber) {
      continue; // skip blank order number
    }

    const numeric = {};
    ['quantity', 'netSale', 'sellerVoucher', 'commission', 'transactionFee'].forEach((key) => {
      const parsed = parseNumber(get(key));
      if (parsed === null) {
        invalidNumericCells.push(`${SOURCE_HEADERS[key]} row ${rowNumber}`);
        numeric[key] = 0; // fail safe: blank/invalid -> 0
      } else {
        numeric[key] = parsed;
      }
    });

    rows.push({
      sourceRowNumber: rowNumber,
      orderNumber,
      status: normalizeText(get('status')) || 'ไม่ระบุสถานะ',
      orderDate: get('orderDate'),
      productName: normalizeText(get('productName')),
      sku: normalizeText(get('sku')),
      variation: normalizeText(get('variation')),
      ...numeric,
      completedAtRaw: get('completedAt'),
    });
  }

  if (invalidNumericCells.length) {
    warnings.push(
      `Converted ${invalidNumericCells.length} unreadable numeric cell(s) to 0: ${invalidNumericCells
        .slice(0, 5)
        .join(', ')}${invalidNumericCells.length > 5 ? ', ...' : ''}`,
    );
  }

  if (!rows.length) {
    throw badRequest('The Shopee workbook does not contain any order rows.');
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Cycle filtering + fail-closed weekly allocation
// ---------------------------------------------------------------------------

function parseCycleWindow(profile) {
  return {
    start: parseDateTime(`${profile.periodStart} 00:00:00`),
    end: parseDateTime(`${profile.periodEnd} 23:59:59`),
  };
}

function parseWeekWindow(week) {
  return {
    start: parseDateTime(`${week.start} 00:00:00`),
    end: parseDateTime(`${week.end} 23:59:59`),
  };
}

function assessSourceCoverage(rows, filenamePeriod, profile) {
  const sourceWindowEnd = filenamePeriod
    ? parseDateTime(`${filenamePeriod.periodEnd} 23:59:59`)
    : null;
  let completedAfterSourcePeriod = 0;

  if (sourceWindowEnd) {
    rows.forEach((row) => {
      if (row.status === profile.cancelledStatus || !normalizeText(row.completedAtRaw)) return;
      const completedAt = row.completedAtRaw instanceof Date
        ? row.completedAtRaw
        : parseDateTime(row.completedAtRaw);
      if (completedAt && completedAt > sourceWindowEnd) completedAfterSourcePeriod += 1;
    });
  }

  return {
    completedAfterSourcePeriod,
    // Backwards-compatible audit keys. The Shopee picker is now an explicit order-date contract,
    // so no inferred evidence or fixed lookback is needed to establish the cycle boundary.
    minimumLookbackStart: null,
    orderDateFilterEvidence: true,
    sourceCoverageStatus: 'order_date_window_covered',
  };
}

function applyCycle(rows, profile) {
  const window = parseCycleWindow(profile);
  const cancelledStatus = profile.cancelledStatus;

  let cancelledExcluded = 0;
  let carryoverExcluded = 0;
  let outOfRangeExcluded = 0;
  let orderDateBeforeCycleExcluded = 0;
  let orderDateAfterCycleExcluded = 0;
  let completedBeforeCycleObserved = 0;
  let completedAfterCycleObserved = 0;
  let pendingCompletionExcluded = 0;
  const pendingCompletionOrderNumbers = new Set();
  const pendingCompletionStatusMap = new Map();
  const included = [];
  const orderNumberSet = new Set();
  const duplicateOrderNumbers = new Set();

  rows.forEach((row) => {
    const status = row.status;

    // Cancelled rows are excluded before date parsing. Shopee commonly leaves the completed-time
    // cell blank for them, and cancelled orders never belong in an accounting completion cycle.
    if (status === cancelledStatus) {
      cancelledExcluded += 1;
      return;
    }

    // Shopee's export picker and this accounting cycle both use the order-created timestamp.
    // Parse it before looking at completion so out-of-cycle rows cannot affect this document.
    const orderDate = row.orderDate instanceof Date
      ? new Date(row.orderDate.getTime())
      : parseDateTime(row.orderDate);
    if (!(orderDate instanceof Date) || Number.isNaN(orderDate.getTime())) {
      throw badRequest(
        `Could not parse the order date on source row ${row.sourceRowNumber}; cannot determine the accounting cycle.`,
        { sourceRowNumber: row.sourceRowNumber, orderNumber: row.orderNumber },
      );
    }

    if (orderDate < window.start) {
      orderDateBeforeCycleExcluded += 1;
      outOfRangeExcluded += 1;
      return;
    }

    if (orderDate > window.end) {
      orderDateAfterCycleExcluded += 1;
      carryoverExcluded += 1;
      return;
    }

    // A non-cancelled in-cycle row can legitimately have no completed time yet. Exclude it from
    // the current document but keep the cycle open for a refreshed export of the same order-date
    // period. A non-blank malformed value still fails closed because column M must remain typed.
    if (!normalizeText(row.completedAtRaw)) {
      pendingCompletionExcluded += 1;
      pendingCompletionOrderNumbers.add(row.orderNumber);
      const statusEntry = pendingCompletionStatusMap.get(status) || {
        status,
        rowCount: 0,
        orderNumbers: new Set(),
      };
      statusEntry.rowCount += 1;
      statusEntry.orderNumbers.add(row.orderNumber);
      pendingCompletionStatusMap.set(status, statusEntry);
      return;
    }

    const completedAt = row.completedAtRaw instanceof Date
      ? new Date(row.completedAtRaw.getTime())
      : parseDateTime(row.completedAtRaw);
    if (!(completedAt instanceof Date) || Number.isNaN(completedAt.getTime())) {
      throw badRequest(
        `Source row ${row.sourceRowNumber} (order ${row.orderNumber}) has no parseable completed time (เวลาที่ทำการสั่งซื้อสำเร็จ); cannot determine the accounting cycle.`,
        { sourceRowNumber: row.sourceRowNumber, orderNumber: row.orderNumber },
      );
    }

    if (completedAt < window.start) completedBeforeCycleObserved += 1;
    if (completedAt > window.end) completedAfterCycleObserved += 1;

    // Duplicate-order tracking (informational; row-based totals preserved).
    if (orderNumberSet.has(row.orderNumber)) {
      duplicateOrderNumbers.add(row.orderNumber);
    }
    orderNumberSet.add(row.orderNumber);

    included.push({ ...row, orderDate, completedAt });
  });

  // Allocate each included row to a week by the same order-date field used for membership.
  // An in-cycle value that does not match a week is a profile invariant failure and must surface.
  const weekWindows = profile.weeks.map((week) => ({ week, window: parseWeekWindow(week) }));
  const byWeek = new Map(profile.weeks.map((week) => [week.name, []]));

  included.forEach((row) => {
    const match = weekWindows.find(
      ({ window: weekWindow }) => row.orderDate >= weekWindow.start && row.orderDate <= weekWindow.end,
    );
    if (!match) {
      throw badRequest(
        `Source row ${row.sourceRowNumber} (order ${row.orderNumber}) was ordered at ${row.orderDate.toISOString()} and does not fall in any configured weekly sheet; cannot allocate.`,
        {
          sourceRowNumber: row.sourceRowNumber,
          orderNumber: row.orderNumber,
          orderDate: row.orderDate.toISOString(),
        },
      );
    }
    byWeek.get(match.week.name).push(row);
  });

  return {
    included,
    byWeek,
    cancelledExcluded,
    carryoverExcluded,
    outOfRangeExcluded,
    orderDateBeforeCycleExcluded,
    orderDateAfterCycleExcluded,
    // Kept as zero-valued compatibility keys: completion time no longer excludes membership.
    completedBeforeCycleExcluded: 0,
    completedAfterCycleExcluded: 0,
    completedBeforeCycleObserved,
    completedAfterCycleObserved,
    pendingCompletionExcluded,
    pendingCompletionOrderCount: pendingCompletionOrderNumbers.size,
    pendingCompletionStatuses: Array.from(pendingCompletionStatusMap.values()).map((entry) => ({
      status: entry.status,
      rowCount: entry.rowCount,
      orderCount: entry.orderNumbers.size,
    })),
    uniqueOrderCount: orderNumberSet.size,
    duplicateOrderCount: duplicateOrderNumbers.size,
  };
}

// ---------------------------------------------------------------------------
// Workbook rendering
// ---------------------------------------------------------------------------

function netRevenueExact(row) {
  // Exact decimal — NO rounding of the value. The #,##0 numFmt is display-only.
  return round2(row.netSale - row.sellerVoucher - row.commission - row.transactionFee);
}

function buildMasterSheet(workbook, profile, cycle) {
  const sheet = workbook.addWorksheet(profile.masterSheetName);

  // Header row 1
  const headerRow = sheet.getRow(1);
  OUTPUT_HEADERS.forEach((label, index) => {
    headerRow.getCell(index + 1).value = label;
  });
  headerRow.height = profile.geometry.master.rowHeights.header;

  // Data rows grouped by week, raw sourceRowNumber preserved within each group.
  let outRow = 2;
  profile.weeks.forEach((week) => {
    const rows = cycle.byWeek.get(week.name) || [];
    rows.forEach((row) => {
      writeDataRow(sheet, outRow, row, week.masterRowFill, null, profile.geometry.master.rowHeights.data);
      outRow += 1;
    });
  });

  applySheetGeometry(sheet, profile.geometry.master);
  applyCommonCellStyling(sheet, { dataStartRow: 2, wrapColumns: [3], multilineHeaderRow: 1 });
  applyNumberFormats(sheet);

  // Comment at 06!L1
  setCellNote(sheet.getCell('L1'), profile.comments.masterL1);

  return sheet;
}

function buildWeeklySheet(workbook, profile, week, rows) {
  const sheet = workbook.addWorksheet(week.name);

  // Period label at D1
  sheet.getCell('D1').value = week.name;
  sheet.getRow(1).height = profile.geometry.weekly.rowHeights.period;

  // Header row 2
  const headerRow = sheet.getRow(2);
  OUTPUT_HEADERS.forEach((label, index) => {
    headerRow.getCell(index + 1).value = label;
  });
  headerRow.height = profile.geometry.weekly.rowHeights.header;

  // Sort completed time ascending, then raw source row number.
  const sorted = [...rows].sort((a, b) => {
    if (a.completedAt.getTime() !== b.completedAt.getTime()) {
      return a.completedAt.getTime() - b.completedAt.getTime();
    }
    return a.sourceRowNumber - b.sourceRowNumber;
  });

  // Distinct completed dates (oldest-first) cycle through weeklyDateFills; same date = same color.
  const dateOrder = [];
  sorted.forEach((row) => {
    const key = dateKey(row.completedAt);
    if (!dateOrder.includes(key)) dateOrder.push(key);
  });
  const dateColor = new Map(dateOrder.map((key, index) => [key, profile.weeklyDateFills[index % profile.weeklyDateFills.length]]));

  let outRow = 3;
  sorted.forEach((row) => {
    const mColor = dateColor.get(dateKey(row.completedAt));
    writeDataRow(sheet, outRow, row, null, { mColor }, profile.geometry.weekly.rowHeights.data);
    outRow += 1;
  });

  applySheetGeometry(sheet, profile.geometry.weekly);
  applyCommonCellStyling(sheet, { dataStartRow: 2, wrapColumns: [3], multilineHeaderRow: 2, periodRow: 1 });

  // Header fill #C0E6F5 on A2:M2
  for (let col = 1; col <= 13; col += 1) {
    sheet.getRow(2).getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: profile.weeklyHeaderFill } };
  }

  applyNumberFormats(sheet);

  // Comment at L2
  setCellNote(sheet.getCell('L2'), profile.comments.weeklyL2);

  // Print area = used range (A1:M<lastDataRow>).
  const lastDataRow = Math.max(3, sorted.length + 2);
  sheet.pageSetup.printArea = `A1:M${lastDataRow}`;

  return sheet;
}

function writeDataRow(sheet, outRow, row, rowFill, columnFills, dataRowHeight) {
  const target = sheet.getRow(outRow);
  const net = netRevenueExact(row);
  target.values = [
    row.orderNumber, // A text
    row.orderDate instanceof Date ? new Date(row.orderDate.getTime()) : row.orderDate, // B Date
    row.productName, // C
    row.variation, // D
    row.sku, // E text
    row.quantity, // F
    row.status, // G
    row.netSale, // H
    row.sellerVoucher, // I
    row.commission, // J
    row.transactionFee, // K
    null, // L placeholder (formula set below)
    row.completedAt instanceof Date ? new Date(row.completedAt.getTime()) : row.completedAt, // M Date
  ];
  // L = formula with EXACT decimal cached result (display rounding via numFmt only).
  target.getCell(12).value = { formula: `H${outRow}-I${outRow}-J${outRow}-K${outRow}`, result: net };
  // Data row height is set at write time so both master (row 2+) and weekly (row 3+) offsets
  // are covered deterministically, regardless of sheet kind.
  target.height = dataRowHeight;

  if (rowFill) {
    for (let col = 1; col <= 13; col += 1) {
      target.getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowFill } };
    }
  }
  if (columnFills && columnFills.mColor) {
    target.getCell(13).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: columnFills.mColor } };
  }
}

function applySheetGeometry(sheet, geometry) {
  geometry.widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });

  sheet.views = [{ zoomScale: geometry.zoom, showGridLines: true }];
  // No freeze panes anywhere (spec).

  // Print mode is derived from the profile, not hardcoded. Spec §11 (master) is a literal
  // fixed 100% print scale with no fit-to-page; spec §12 (weekly) is fit-to-1-page-wide with
  // automatic tall pages. The config signals this: master's geometry.print carries `scale`
  // (no fit keys); weekly's carries `fitToWidth`/`fitToHeight` (no scale). Mixing the two —
  // e.g. fitToPage:true on the master — is not a well-defined Excel print state.
  const isFitToPageMode = geometry.print.fitToWidth !== undefined || geometry.print.fitToHeight !== undefined;
  sheet.pageSetup = {
    ...sheet.pageSetup,
    paperSize: geometry.print.paperSize, // A4
    orientation: geometry.print.orientation,
    fitToPage: isFitToPageMode,
    fitToWidth: geometry.print.fitToWidth ?? 0,
    fitToHeight: geometry.print.fitToHeight ?? 0,
  };
  if (geometry.print.scale !== undefined) {
    sheet.pageSetup.scale = geometry.print.scale;
  }
}

function applyCommonCellStyling(sheet, { dataStartRow, wrapColumns, multilineHeaderRow, periodRow }) {
  const styleCell = (cell, { wrapText }) => {
    cell.font = { ...FONT };
    cell.alignment = { ...ALIGNMENT, ...(wrapText ? { wrapText: true } : {}) };
    // No borders (spec).
  };

  // Period row (weekly only): style D1 area cells up to used width.
  if (periodRow) {
    sheet.getRow(periodRow).eachCell({ includeEmpty: true }, (cell) => styleCell(cell, { wrapText: false }));
  }

  // Header row
  const headerRowNumber = multilineHeaderRow;
  sheet.getRow(headerRowNumber).eachCell({ includeEmpty: true }, (cell, colNumber) => {
    styleCell(cell, { wrapText: wrapColumns.includes(colNumber) || [9, 10, 11].includes(colNumber) });
  });

  // Data rows
  for (let r = dataStartRow; r <= sheet.rowCount; r += 1) {
    if (!sheet.getRow(r).getCell(1).value) continue;
    sheet.getRow(r).eachCell({ includeEmpty: true }, (cell, colNumber) => {
      styleCell(cell, { wrapText: wrapColumns.includes(colNumber) });
    });
  }
}

function applyNumberFormats(sheet) {
  sheet.getColumn(1).numFmt = '@'; // A text
  sheet.getColumn(2).numFmt = 'yyyy-mm-dd hh:mm'; // B Date
  sheet.getColumn(5).numFmt = '@'; // E text
  sheet.getColumn(6).numFmt = '#,##0'; // F
  sheet.getColumn(7).numFmt = '@'; // G status text
  sheet.getColumn(8).numFmt = '#,##0.00'; // H
  sheet.getColumn(9).numFmt = '#,##0.00'; // I
  sheet.getColumn(10).numFmt = '#,##0.00'; // J
  sheet.getColumn(11).numFmt = '#,##0.00'; // K
  sheet.getColumn(12).numFmt = '#,##0'; // L display-only
  sheet.getColumn(13).numFmt = 'yyyy-mm-dd hh:mm'; // M Date
}

function setCellNote(cell, text) {
  // A plain string is the one note shape this ExcelJS version round-trips cleanly (arrays of
  // runs throw on write; {texts:[...]} collapses to a string on read). Keep it simple and exact.
  cell.note = text;
}

// ---------------------------------------------------------------------------
// Metadata assembly
// ---------------------------------------------------------------------------

function buildMetadata(profile, cycle, sourceSheetName, filenamePeriod) {
  const included = cycle.included;
  const weeklyCounts = {};
  const weeklyNetTotals = {};
  profile.weeks.forEach((week) => {
    const rows = cycle.byWeek.get(week.name) || [];
    weeklyCounts[week.name] = rows.length;
    weeklyNetTotals[week.name] = round2(rows.reduce((sum, row) => sum + netRevenueExact(row), 0));
  });

  const totals = included.reduce(
    (acc, row) => ({
      netSale: round2(acc.netSale + row.netSale),
      sellerFundedDiscount: round2(acc.sellerFundedDiscount + row.sellerVoucher),
      commission: round2(acc.commission + row.commission),
      transactionFee: round2(acc.transactionFee + row.transactionFee),
      quantity: round2(acc.quantity + row.quantity),
    }),
    { netSale: 0, sellerFundedDiscount: 0, commission: 0, transactionFee: 0, quantity: 0 },
  );

  const statusMap = new Map();
  included.forEach((row) => {
    const entry = statusMap.get(row.status) || { status: row.status, rowCount: 0, quantity: 0 };
    entry.rowCount += 1;
    entry.quantity = round2(entry.quantity + row.quantity);
    statusMap.set(row.status, entry);
  });

  return {
    // Preserved keys (consumed by workbookService.js / workbookRules.js)
    periodStart: profile.periodStart,
    periodEnd: profile.periodEnd,
    printPolicy: 'manual',
    sourceSheetName,
    rowCount: included.length,
    uniqueOrderCount: cycle.uniqueOrderCount,
    duplicateOrderCount: cycle.duplicateOrderCount,
    statuses: Array.from(statusMap.values()),
    totals,
    privacyExcludedHeaders: EXCLUDED_PII_HEADERS.slice(),
    // Extended accounting-cycle keys
    cycleKey: profile.cycleKey,
    cycleLabel: profile.cycleLabel,
    rawRows: cycle.rawRows,
    blankSkipped: cycle.blankSkipped,
    cancelledExcluded: cycle.cancelledExcluded,
    carryoverExcluded: cycle.carryoverExcluded,
    outOfRangeExcluded: cycle.outOfRangeExcluded,
    orderDateBeforeCycleExcluded: cycle.orderDateBeforeCycleExcluded,
    orderDateAfterCycleExcluded: cycle.orderDateAfterCycleExcluded,
    completedBeforeCycleExcluded: cycle.completedBeforeCycleExcluded,
    completedAfterCycleExcluded: cycle.completedAfterCycleExcluded,
    completedBeforeCycleObserved: cycle.completedBeforeCycleObserved,
    completedAfterCycleObserved: cycle.completedAfterCycleObserved,
    pendingCompletionExcluded: cycle.pendingCompletionExcluded,
    pendingCompletionOrderCount: cycle.pendingCompletionOrderCount,
    pendingCompletionStatuses: cycle.pendingCompletionStatuses,
    completedAfterSourcePeriod: cycle.sourceCoverage.completedAfterSourcePeriod,
    minimumLookbackStart: cycle.sourceCoverage.minimumLookbackStart,
    orderDateFilterEvidence: cycle.sourceCoverage.orderDateFilterEvidence,
    sourceCoverageStatus: cycle.sourceCoverage.sourceCoverageStatus,
    cycleDateField: 'order_created_at',
    finalRows: included.length,
    cycleClosureStatus: cycle.pendingCompletionExcluded
      ? 'review_required_pending'
      : included.length
        ? 'ready_with_rows'
        : 'review_required_empty',
    checkpointEligible: included.length > 0 && cycle.pendingCompletionExcluded === 0,
    weeklyCounts,
    weeklyNetTotals,
    sheets: [profile.masterSheetName, ...profile.weeks.map((week) => week.name)],
  };
}

// ---------------------------------------------------------------------------
// Public transform
// ---------------------------------------------------------------------------

async function transformShopeeWorkbook(sourceWorkbook, options = {}) {
  const sourceWorksheet =
    sourceWorkbook.worksheets.find((worksheet) => isShopeeWorksheet(worksheet)) || null;
  if (!sourceWorksheet) {
    throw badRequest('The uploaded workbook does not look like a Shopee order export.', {
      requiredHeaders: REQUIRED_HEADERS,
    });
  }

  const header = findShopeeHeader(sourceWorksheet);
  const warnings = [];
  const rows = readSourceRows(sourceWorksheet, header, warnings);

  const filenamePeriod = parseFilenamePeriod(options.originalFilename);
  const { profile } = resolveCycleProfile({
    filenamePeriodStart: filenamePeriod ? filenamePeriod.periodStart : '',
    filenamePeriodEnd: filenamePeriod ? filenamePeriod.periodEnd : '',
  });

  const cycle = applyCycle(rows, profile);
  cycle.sourceCoverage = assessSourceCoverage(rows, filenamePeriod, profile);
  cycle.rawRows = rows.length;
  cycle.blankSkipped = 0; // blank-order rows are skipped silently during read (not tracked per spec)

  // Build the output workbook in exact sheet order: master first, then weeks in profile order.
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ClaspSCxSeamless';
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;
  workbook.calcProperties.forceFullCalc = true;
  workbook.calcProperties.calcMode = 'auto';

  const masterSheet = buildMasterSheet(workbook, profile, cycle);
  profile.weeks.forEach((week) => {
    buildWeeklySheet(workbook, profile, week, cycle.byWeek.get(week.name) || []);
  });

  const metadata = buildMetadata(profile, cycle, sourceWorksheet.name, filenamePeriod);

  // ExcelJS hardcodes font[0] = Calibri 11 in its styles serializer with no public override,
  // but OOXML column widths are measured against the Normal style's font (font[0]). Override
  // writeBuffer so every serialized byte stream has font[0] = the rendering font (Angsana New
  // 14); otherwise the narrow date columns overflow to ############# because their stored
  // widths are interpreted in Calibri-11 units. The in-memory model (used by copyWorksheet for
  // previews) is unaffected — only the XLSX byte output is rewritten.
  const xlsx = workbook.xlsx;
  const originalWriteBuffer = xlsx.writeBuffer.bind(xlsx);
  xlsx.writeBuffer = async function writeBufferWithDefaultFont() {
    const buffer = await originalWriteBuffer();
    return applyDefaultFont(buffer, DEFAULT_FONT);
  };

  if (cycle.duplicateOrderCount) {
    warnings.push(
      `Found ${cycle.duplicateOrderCount} order number(s) on multiple rows. Totals remain row-based to preserve the Shopee export exactly.`,
    );
  }

  if (cycle.pendingCompletionExcluded) {
    warnings.push(
      `Excluded ${cycle.pendingCompletionExcluded} non-cancelled in-cycle row(s) across ${cycle.pendingCompletionOrderCount} order(s) because Shopee has not assigned a completed time yet. Re-export this same order-date period after they complete before closing the cycle.`,
    );
  }

  return {
    workbook,
    worksheet: masterSheet, // preview-safe, self-contained
    detectedVariant: 'shopee',
    effectiveVariant: 'shopee',
    warnings,
    deletedColumns: EXCLUDED_PII_HEADERS.map((headerText) => ({
      headerText,
      strategy: 'excluded-from-print-output',
    })),
    highlightCount: 0,
    metadata,
  };
}

module.exports = {
  EXCLUDED_PII_HEADERS,
  REQUIRED_HEADERS,
  SOURCE_HEADERS,
  OUTPUT_HEADERS,
  findShopeeHeader,
  isShopeeWorksheet,
  parseDateTime,
  parseFilenamePeriod,
  parseNumber,
  transformShopeeWorkbook,
};
