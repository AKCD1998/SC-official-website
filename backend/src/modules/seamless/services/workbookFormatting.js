// Ported from the original SeamlessXGASExcelFormatV2 Google Apps Script pipeline
// (src/transforms/Formatting.gs, MergedRangeUtils.gs, SheetUtils.gs, Normalize.gs,
// Config.gs, WorkbookVariant.gs) — the Node rewrite had replaced this print-tuned
// column-width/row-height/merge-preserving engine with a crude text-length heuristic,
// which is why fresh app output looked visually different from the legacy GAS output.
//
// Unit note: GAS's SpreadsheetApp API only accepts pixels for setColumnWidth/setRowHeight,
// so the original code converts its internal "Excel character width" units to pixels before
// applying them. ExcelJS's `column.width` and `row.height` already use those same native
// Excel units directly (characters and points respectively), so this port skips that pixel
// conversion when *applying* widths/heights — it's only kept for the printable-width-fitting
// math below, which reasons about a fixed physical page width in inches.

const CONFIG = {
  MIN_COLUMN_WIDTH: 6,
  MAX_COLUMN_WIDTH: 24,
  DATA_COLUMN_MAX_WIDTH: 11,
  HEADER_SINGLE_COLUMN_MAX_WIDTH: 14,
  HEADER_MERGED_COLUMN_MAX_WIDTH: 10,
  PRINT_TARGET_WIDTH_INCHES: 9.6,
  PRINT_PIXEL_DPI: 96,
  PRINT_MIN_COLUMN_WIDTH: 3,
  PRINT_WIDTH_SHRINK_STEP: 0.25,
  BODY_ROW_HEIGHT_RATIO: 1.5,
  HEADER_ROW_HEIGHT_RATIO: 1.75,
  HEADER_ROW_MAX_RATIO: 5.25,
  TARGET_SIDE_PADDING_PX: 2,
  APPROX_EXCEL_CHARACTER_WIDTH_PX: 7,
  TARGET_FONT_SIZE: 9,
  INDIVIDUAL_FIXED_COLUMN_WIDTHS: {
    ลำดับที่: 3,
    'REP No.': 10.22,
    'Trans ID': 10.22,
    HN: 8,
    AN: 10.22,
    'VCTID,NAPNumber,PID': 9,
    'ชื่อ-สกุล': 13.78,
    สิทธิการรักษาพยาบาล: 6,
    HCODE: 6,
    'วันที่เข้ารักษา/วันที่รับบริการ': 8,
    รายการประเภทที่ขอเบิก: 15,
    จำนวน: 3,
    ราคาต่อหน่วย: 5,
    ราคาเพดาน: 5,
    รวมเงินที่ขอเบิก: 6,
    'PS CODE': 3,
    '%': 3,
    ชดเชย: 6,
    ไม่ชดเชย: 6,
    จ่ายเพิ่ม: 6,
    เรียกคืน: 6,
  },
  INDIVIDUAL_FIXED_ROW_HEIGHTS: {
    8: 15,
    9: 15,
    10: 15,
  },
};

CONFIG.TABLE_COLUMN_PADDING = (CONFIG.TARGET_SIDE_PADDING_PX * 2) / CONFIG.APPROX_EXCEL_CHARACTER_WIDTH_PX;
CONFIG.PRINT_TARGET_WIDTH_PIXELS = CONFIG.PRINT_TARGET_WIDTH_INCHES * CONFIG.PRINT_PIXEL_DPI;

function segmentGraphemes(text) {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(String(text || '')), (s) => s.segment);
  }

  return Array.from(String(text || ''));
}

function estimateGraphemeWidth(grapheme) {
  if (!grapheme) {
    return 0;
  }

  if (/^\s$/u.test(grapheme)) {
    return 0.45;
  }

  if (/^[0-9]$/u.test(grapheme)) {
    return 0.9;
  }

  if (/^[A-Z]$/u.test(grapheme)) {
    return 1;
  }

  if (/^[a-z]$/u.test(grapheme)) {
    return 0.9;
  }

  if (/^[฀-๿]$/u.test(grapheme)) {
    return 1;
  }

  if (/^[⺀-鿿]$/u.test(grapheme)) {
    return 1.6;
  }

  if (",.:;'\"`~!@#$%^&*()_-=+/?\\|[]{}<>".includes(grapheme)) {
    return 0.6;
  }

  return 1;
}

function estimateLineWidth(text) {
  const normalized = String(text || '');
  if (!normalized) {
    return 0;
  }

  return segmentGraphemes(normalized).reduce((total, grapheme) => total + estimateGraphemeWidth(grapheme), 0);
}

function roundWidth(width) {
  return Math.round(width * 100) / 100;
}

function clampWidth(width) {
  return roundWidth(Math.max(CONFIG.MIN_COLUMN_WIDTH, Math.min(CONFIG.MAX_COLUMN_WIDTH, width)));
}

function getColumnWidthPixels(width) {
  return Math.trunc(((256 * width + Math.trunc(128 / 7)) / 256) * 7);
}

// --- Merge-range utilities -------------------------------------------------

function decodeRangeAddress(address) {
  const [fromAddr, toAddr] = address.includes(':') ? address.split(':') : [address, address];
  const from = ExcelJSAddress(fromAddr);
  const to = ExcelJSAddress(toAddr);
  return {
    top: Math.min(from.row, to.row),
    left: Math.min(from.col, to.col),
    bottom: Math.max(from.row, to.row),
    right: Math.max(from.col, to.col),
  };
}

// Minimal A1 address decoder (avoids depending on exceljs internals).
function ExcelJSAddress(addr) {
  const match = /^([A-Z]+)(\d+)$/.exec(addr);
  if (!match) {
    throw new Error(`Invalid cell address: ${addr}`);
  }

  const [, colLetters, rowDigits] = match;
  let col = 0;
  for (let i = 0; i < colLetters.length; i += 1) {
    col = col * 26 + (colLetters.charCodeAt(i) - 64);
  }

  return { row: Number(rowDigits), col };
}

function getMergedRanges(worksheet) {
  const merges = (worksheet.model && worksheet.model.merges) || [];
  return merges.map(decodeRangeAddress);
}

function buildMergeIndex(mergeRanges) {
  const index = {};
  mergeRanges.forEach((range) => {
    for (let row = range.top; row <= range.bottom; row += 1) {
      for (let col = range.left; col <= range.right; col += 1) {
        index[`${row}:${col}`] = range;
      }
    }
  });
  return index;
}

function getMergeRangeAt(index, row, col) {
  return index[`${row}:${col}`] || null;
}

function columnLetter(col) {
  let result = '';
  let n = col;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

function rangeToA1(range) {
  return `${columnLetter(range.left)}${range.top}:${columnLetter(range.right)}${range.bottom}`;
}

function isColumnDeleted(columnNumber, columnRanges) {
  return columnRanges.some((range) => columnNumber >= range.start && columnNumber <= range.start + range.count - 1);
}

function mapColumnAfterDeletes(columnNumber, columnRanges) {
  let removed = 0;
  columnRanges.forEach((range) => {
    const end = range.start + range.count - 1;
    if (end < columnNumber) {
      removed += range.count;
    }
  });
  return columnNumber - removed;
}

function adjustRangeAfterColumnDeletes(range, columnRanges) {
  const survivingColumns = [];
  for (let col = range.left; col <= range.right; col += 1) {
    if (isColumnDeleted(col, columnRanges)) {
      continue;
    }
    survivingColumns.push(mapColumnAfterDeletes(col, columnRanges));
  }

  if (!survivingColumns.length) {
    return null;
  }

  return {
    top: range.top,
    left: survivingColumns[0],
    bottom: range.bottom,
    right: survivingColumns[survivingColumns.length - 1],
  };
}

// Deletes the given column ranges (each { start, count }) while preserving merged
// ranges that survive the deletion — ExcelJS's own `spliceColumns` does not reliably
// carry merges through, which is why the Node rewrite lost the multi-row merged
// header structure that the legacy GAS output always had.
function deleteColumnsPreservingMerges(worksheet, columnRanges) {
  if (!columnRanges || !columnRanges.length) {
    return;
  }

  const mergeRanges = getMergedRanges(worksheet);

  mergeRanges.forEach((range) => {
    worksheet.unMergeCells(rangeToA1(range));
  });

  const sortedRanges = columnRanges.slice().sort((left, right) => right.start - left.start);
  sortedRanges.forEach((range) => {
    worksheet.spliceColumns(range.start, range.count);
  });

  const uniqueAdjustedMerges = new Map();
  mergeRanges.forEach((range) => {
    const adjusted = adjustRangeAfterColumnDeletes(range, sortedRanges);
    if (!adjusted || (adjusted.top === adjusted.bottom && adjusted.left === adjusted.right)) {
      return;
    }
    uniqueAdjustedMerges.set(rangeToA1(adjusted), adjusted);
  });

  uniqueAdjustedMerges.forEach((range) => {
    worksheet.mergeCells(rangeToA1(range));
  });
}

// --- Sheet model (bounds + resolved display values) ------------------------

function buildSheetModel(worksheet, safeCellText) {
  const mergeRanges = getMergedRanges(worksheet);
  const mergeIndex = buildMergeIndex(mergeRanges);

  return {
    worksheet,
    mergeRanges,
    mergeIndex,
    safeCellText,
  };
}

function getResolvedDisplayValue(model, rowNumber, columnNumber) {
  const mergeRange = getMergeRangeAt(model.mergeIndex, rowNumber, columnNumber);
  const anchorRow = mergeRange ? mergeRange.top : rowNumber;
  const anchorCol = mergeRange ? mergeRange.left : columnNumber;
  return model.safeCellText(model.worksheet, anchorRow, anchorCol);
}

function findFirstHeaderRowInRange(model, startCol, endCol, headerRows) {
  for (const rowNumber of headerRows) {
    for (let columnNumber = startCol; columnNumber <= endCol; columnNumber += 1) {
      if (getResolvedDisplayValue(model, rowNumber, columnNumber)) {
        return rowNumber;
      }
    }
  }
  return null;
}

function findLastNonEmptyRowInRange(worksheet, startCol, endCol, startScanRow, getCellText) {
  const lastRow = worksheet.rowCount;
  let lastNonEmptyRow = null;

  for (let rowNumber = startScanRow; rowNumber <= lastRow; rowNumber += 1) {
    let hasValue = false;
    for (let columnNumber = startCol; columnNumber <= endCol; columnNumber += 1) {
      if (getCellText(worksheet, rowNumber, columnNumber)) {
        hasValue = true;
        break;
      }
    }
    if (hasValue) {
      lastNonEmptyRow = rowNumber;
    }
  }

  return lastNonEmptyRow;
}

// --- Column width calculation -----------------------------------------------

function isHeaderRow(rowNumber, headerRows) {
  return headerRows.includes(rowNumber);
}

function getSizingProfile(rowNumber, mergeRange, headerRows) {
  if (isHeaderRow(rowNumber, headerRows)) {
    if (mergeRange && mergeRange.right > mergeRange.left) {
      return { maxPerColumn: CONFIG.HEADER_MERGED_COLUMN_MAX_WIDTH };
    }
    return { maxPerColumn: CONFIG.HEADER_SINGLE_COLUMN_MAX_WIDTH };
  }

  return { maxPerColumn: CONFIG.DATA_COLUMN_MAX_WIDTH };
}

function estimateColumnWidth(text, options) {
  const lines = text ? String(text).split('\n') : [''];
  const widest = lines.reduce((max, line) => Math.max(max, estimateLineWidth(line)), 0);
  const width = widest + (options.padding || 0);
  return Math.max(options.min || 1, Math.min(options.max || 80, roundWidth(width)));
}

function applyFixedColumnWidths(model, scanRange, widths, options) {
  const { fixedColumnWidths, headerRows } = options;
  if (!fixedColumnWidths) {
    return;
  }

  headerRows.forEach((rowNumber) => {
    if (rowNumber < scanRange.top || rowNumber > scanRange.bottom) {
      return;
    }

    for (let columnNumber = scanRange.left; columnNumber <= scanRange.right; columnNumber += 1) {
      const mergeRange = getMergeRangeAt(model.mergeIndex, rowNumber, columnNumber);
      if (mergeRange && (mergeRange.top !== rowNumber || mergeRange.left !== columnNumber)) {
        continue;
      }

      const span = mergeRange ? mergeRange.right - mergeRange.left + 1 : 1;
      if (span !== 1) {
        continue;
      }

      const headerText = getResolvedDisplayValue(model, rowNumber, columnNumber);
      const normalizedHeaderText = String(headerText || '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
      if (!normalizedHeaderText || typeof fixedColumnWidths[normalizedHeaderText] === 'undefined') {
        continue;
      }

      widths[columnNumber] = fixedColumnWidths[normalizedHeaderText];
    }
  });
}

function calculateColumnWidths(model, scanRange, options) {
  const widths = {};
  const visited = new Set();
  const headerRows = options.headerRows || [];
  const fixedColumnWidths = options.fixedColumnWidths || null;

  for (let columnNumber = scanRange.left; columnNumber <= scanRange.right; columnNumber += 1) {
    widths[columnNumber] = CONFIG.MIN_COLUMN_WIDTH;
  }

  for (let rowNumber = scanRange.top; rowNumber <= scanRange.bottom; rowNumber += 1) {
    for (let columnNumber = scanRange.left; columnNumber <= scanRange.right; columnNumber += 1) {
      const mergeRange = getMergeRangeAt(model.mergeIndex, rowNumber, columnNumber);

      if (
        mergeRange &&
        (mergeRange.right < scanRange.left ||
          mergeRange.left > scanRange.right ||
          mergeRange.bottom < scanRange.top ||
          mergeRange.top > scanRange.bottom)
      ) {
        continue;
      }

      const key = mergeRange ? rangeToA1(mergeRange) : `${rowNumber}:${columnNumber}`;
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);

      if (mergeRange && (mergeRange.top !== rowNumber || mergeRange.left !== columnNumber)) {
        continue;
      }

      const text = getResolvedDisplayValue(model, rowNumber, columnNumber);
      if (!text) {
        continue;
      }

      const startColumn = mergeRange ? Math.max(mergeRange.left, scanRange.left) : columnNumber;
      const endColumn = mergeRange ? Math.min(mergeRange.right, scanRange.right) : columnNumber;
      const span = endColumn - startColumn + 1;
      const sizingProfile = getSizingProfile(rowNumber, mergeRange, headerRows);
      const estimatedWidth = estimateColumnWidth(text, {
        min: CONFIG.MIN_COLUMN_WIDTH,
        max: sizingProfile.maxPerColumn * span,
        padding: CONFIG.TABLE_COLUMN_PADDING,
      });
      const widthPerColumn = clampWidth(Math.min(sizingProfile.maxPerColumn, estimatedWidth / span));

      for (let currentColumn = startColumn; currentColumn <= endColumn; currentColumn += 1) {
        widths[currentColumn] = Math.max(widths[currentColumn] || CONFIG.MIN_COLUMN_WIDTH, widthPerColumn);
      }
    }
  }

  applyFixedColumnWidths(model, scanRange, widths, { headerRows, fixedColumnWidths });

  return widths;
}

function getRangeWidthPixels(widthMap, left, right) {
  let total = 0;
  for (let columnNumber = left; columnNumber <= right; columnNumber += 1) {
    total += getColumnWidthPixels(widthMap[columnNumber] || CONFIG.MIN_COLUMN_WIDTH);
  }
  return total;
}

function findWidestReducibleColumn(widthMap, left, right) {
  let widestColumn = 0;
  let widestWidth = CONFIG.PRINT_MIN_COLUMN_WIDTH;

  for (let columnNumber = left; columnNumber <= right; columnNumber += 1) {
    const currentWidth = widthMap[columnNumber] || CONFIG.MIN_COLUMN_WIDTH;
    if (currentWidth <= CONFIG.PRINT_MIN_COLUMN_WIDTH) {
      continue;
    }
    if (currentWidth > widestWidth) {
      widestWidth = currentWidth;
      widestColumn = columnNumber;
    }
  }

  return widestColumn;
}

function squeezeWidthMap(widthMap, left, right, targetWidthPixels) {
  let guard = 0;
  while (getRangeWidthPixels(widthMap, left, right) > targetWidthPixels && guard < 2000) {
    const widestColumn = findWidestReducibleColumn(widthMap, left, right);
    if (!widestColumn) {
      break;
    }
    widthMap[widestColumn] = roundWidth(
      Math.max(CONFIG.PRINT_MIN_COLUMN_WIDTH, widthMap[widestColumn] - CONFIG.PRINT_WIDTH_SHRINK_STEP),
    );
    guard += 1;
  }
}

function fitColumnWidthsToPrintableWidth(widthMap, scanRange) {
  if (!widthMap || !scanRange) {
    return widthMap;
  }

  const totalWidthPixels = getRangeWidthPixels(widthMap, scanRange.left, scanRange.right);
  const targetWidthPixels = CONFIG.PRINT_TARGET_WIDTH_PIXELS;

  if (!totalWidthPixels || totalWidthPixels <= targetWidthPixels) {
    return widthMap;
  }

  const scale = targetWidthPixels / totalWidthPixels;
  const fittedWidths = {};

  for (let columnNumber = scanRange.left; columnNumber <= scanRange.right; columnNumber += 1) {
    const currentWidth = widthMap[columnNumber] || CONFIG.MIN_COLUMN_WIDTH;
    fittedWidths[columnNumber] = roundWidth(Math.max(CONFIG.PRINT_MIN_COLUMN_WIDTH, currentWidth * scale));
  }

  squeezeWidthMap(fittedWidths, scanRange.left, scanRange.right, targetWidthPixels);

  return fittedWidths;
}

function applyColumnWidths(worksheet, widthMap) {
  Object.keys(widthMap).forEach((key) => {
    worksheet.getColumn(Number(key)).width = widthMap[key];
  });
}

// --- Row height calculation --------------------------------------------------

function getBaseRowHeight(rowNumber, headerRows) {
  const ratio = isHeaderRow(rowNumber, headerRows) ? CONFIG.HEADER_ROW_HEIGHT_RATIO : CONFIG.BODY_ROW_HEIGHT_RATIO;
  return roundWidth(CONFIG.TARGET_FONT_SIZE * ratio);
}

function capRowHeight(rowNumber, height, headerRows) {
  if (isHeaderRow(rowNumber, headerRows)) {
    return Math.min(
      Math.max(height, getBaseRowHeight(rowNumber, headerRows)),
      roundWidth(CONFIG.TARGET_FONT_SIZE * CONFIG.HEADER_ROW_MAX_RATIO),
    );
  }
  return Math.max(height, getBaseRowHeight(rowNumber, headerRows));
}

function getEffectiveCellWidth(columnWidths, mergeRange, columnNumber) {
  if (!mergeRange) {
    return columnWidths[columnNumber] || CONFIG.MIN_COLUMN_WIDTH;
  }

  let total = 0;
  for (let currentColumn = mergeRange.left; currentColumn <= mergeRange.right; currentColumn += 1) {
    total += columnWidths[currentColumn] || CONFIG.MIN_COLUMN_WIDTH;
  }
  return Math.max(total, CONFIG.MIN_COLUMN_WIDTH);
}

function estimateWrappedLineCount(text, availableWidth) {
  const normalized = String(text || '');
  if (!normalized) {
    return 1;
  }

  const safeWidth = Math.max(1, Math.floor(availableWidth));
  let totalLines = 0;

  normalized.split('\n').forEach((line) => {
    const lineLength = estimateLineWidth(line || ' ') || 1;
    totalLines += Math.max(1, Math.ceil(lineLength / safeWidth));
  });

  return totalLines;
}

function estimateExplicitLineCount(text) {
  const normalized = String(text || '');
  return normalized ? normalized.split('\n').length : 1;
}

function calculateRequiredRowHeights(model, bounds, columnWidths, options) {
  const headerRows = options.headerRows || [];
  const fixedRowHeights = options.fixedRowHeights || {};
  const requiredHeights = {};
  const visited = new Set();

  for (let rowNumber = bounds.top; rowNumber <= bounds.bottom; rowNumber += 1) {
    requiredHeights[rowNumber] = fixedRowHeights[String(rowNumber)] || getBaseRowHeight(rowNumber, headerRows);
  }

  for (let rowNumber = bounds.top; rowNumber <= bounds.bottom; rowNumber += 1) {
    for (let columnNumber = bounds.left; columnNumber <= bounds.right; columnNumber += 1) {
      const mergeRange = getMergeRangeAt(model.mergeIndex, rowNumber, columnNumber);
      const key = mergeRange ? rangeToA1(mergeRange) : `${rowNumber}:${columnNumber}`;
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);

      if (mergeRange && (mergeRange.top !== rowNumber || mergeRange.left !== columnNumber)) {
        continue;
      }

      const text = getResolvedDisplayValue(model, rowNumber, columnNumber);
      if (!text) {
        continue;
      }

      const wrapText = isHeaderRow(rowNumber, headerRows);
      const effectiveWidth = getEffectiveCellWidth(columnWidths, mergeRange, columnNumber);
      const lineCount = wrapText ? estimateWrappedLineCount(text, effectiveWidth) : estimateExplicitLineCount(text);
      const spanRows = mergeRange ? mergeRange.bottom - mergeRange.top + 1 : 1;
      const rowBaseHeight = getBaseRowHeight(rowNumber, headerRows);
      const perRowHeight = capRowHeight(rowNumber, (rowBaseHeight * lineCount) / spanRows, headerRows);
      const targetStartRow = mergeRange ? mergeRange.top : rowNumber;
      const targetEndRow = mergeRange ? mergeRange.bottom : rowNumber;

      for (let currentRow = targetStartRow; currentRow <= targetEndRow; currentRow += 1) {
        requiredHeights[currentRow] = Math.max(
          requiredHeights[currentRow] || getBaseRowHeight(currentRow, headerRows),
          perRowHeight,
        );
      }
    }
  }

  return requiredHeights;
}

function applyRowHeights(worksheet, model, bounds, columnWidths, options) {
  const requiredHeights = calculateRequiredRowHeights(model, bounds, columnWidths, options);
  const fixedRowHeights = options.fixedRowHeights || {};

  for (let rowNumber = bounds.top; rowNumber <= bounds.bottom; rowNumber += 1) {
    const fixedHeight = fixedRowHeights[String(rowNumber)];
    const heightInPoints = fixedHeight || requiredHeights[rowNumber] || getBaseRowHeight(rowNumber, options.headerRows || []);
    worksheet.getRow(rowNumber).height = heightInPoints;
  }
}

module.exports = {
  CONFIG,
  applyColumnWidths,
  applyRowHeights,
  buildMergeIndex,
  buildSheetModel,
  calculateColumnWidths,
  calculateRequiredRowHeights,
  columnLetter,
  deleteColumnsPreservingMerges,
  findFirstHeaderRowInRange,
  findLastNonEmptyRowInRange,
  fitColumnWidthsToPrintableWidth,
  getMergeRangeAt,
  getMergedRanges,
  getResolvedDisplayValue,
  rangeToA1,
};
