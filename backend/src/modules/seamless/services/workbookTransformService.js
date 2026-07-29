const ExcelJS = require('exceljs');
const {
  HIGHLIGHT_HEADERS,
  TARGET_HEADERS_TO_DELETE,
  findColumnByHeaderText,
  getCellText,
  normalizeHeaderText,
} = require('./workbookRules');
const {
  CONFIG: FORMATTING_CONFIG,
  applyColumnWidths: applyCalculatedColumnWidths,
  applyRowHeights: applyCalculatedRowHeights,
  buildSheetModel,
  calculateColumnWidths,
  deleteColumnsPreservingMerges,
  findFirstHeaderRowInRange,
  findLastNonEmptyRowInRange,
  fitColumnWidthsToPrintableWidth,
} = require('./workbookFormatting');

const INDIVIDUAL_HEADER_ROWS = [8, 9, 10];
const SUMMARY_HEADER_ROWS = [5, 6, 7, 8, 9, 10];

function detectWorkbookVariant(worksheet) {
  const sheetName = normalizeHeaderText(worksheet.name).toLowerCase();
  if (sheetName === 'summary' || sheetName === 'sum') {
    return 'summary';
  }

  const atkMatch = findColumnByHeaderText(worksheet, 'ATK', {
    rowStart: 5,
    rowEnd: 5,
  });

  return atkMatch ? 'summary' : 'individual';
}

function applyWorkbookFont(worksheet) {
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      cell.font = {
        ...(cell.font || {}),
        name: 'AngsanaUPC',
        size: 9,
      };
    });
  });
}

function wrapHeaderRows(worksheet, headerRows) {
  headerRows.forEach((rowNumber) => {
    const row = worksheet.getRow(rowNumber);
    row.eachCell({ includeEmpty: false }, (cell) => {
      cell.alignment = {
        ...(cell.alignment || {}),
        wrapText: true,
        vertical: 'middle',
      };
    });
  });
}

function deleteColumns(worksheet, matches) {
  deleteColumnsPreservingMerges(worksheet, matches);
}

function collectIndividualColumnMatches(worksheet, warnings) {
  const matches = [];

  TARGET_HEADERS_TO_DELETE.forEach((headerText) => {
    const match = findColumnByHeaderText(worksheet, headerText, {
      rowStart: 1,
      rowEnd: Math.min(Math.max(worksheet.rowCount || 1, 1), 10),
    });

    if (!match) {
      warnings.push(`Could not find header "${headerText}" for column deletion.`);
      return;
    }

    matches.push({
      headerText,
      matchedText: match.matchedText,
      strategy: match.strategy,
      start: match.start,
      count: match.count,
      columnLabel: String(match.start),
    });
  });

  return matches;
}

function collectSummaryColumnMatches(worksheet, warnings) {
  const match = findColumnByHeaderText(worksheet, 'ATK', {
    rowStart: 5,
    rowEnd: 5,
  });

  if (!match) {
    warnings.push('Could not find header "ATK" for column deletion.');
    return [];
  }

  return [
    {
      headerText: 'ATK and columns to the right',
      matchedText: match.matchedText,
      strategy: `${match.strategy}-to-right`,
      start: match.start,
      count: Math.max(1, worksheet.columnCount - match.start + 1),
      columnLabel: `${match.start}:${worksheet.columnCount}`,
    },
  ];
}

function isValueExactly150(value) {
  if (value === null || typeof value === 'undefined' || value instanceof Date) {
    return false;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) && value === 150;
  }

  return /^150(?:\.0+)?$/.test(String(value).replace(/,/g, '').trim());
}

function findHighlightColumn(worksheet, headerText) {
  const headerRows = [10, 9, 8];

  for (const rowNumber of headerRows) {
    const match = findColumnByHeaderText(worksheet, headerText, {
      rowStart: rowNumber,
      rowEnd: rowNumber,
    });

    if (match) {
      return match.columnNumber;
    }
  }

  const fallback = findColumnByHeaderText(worksheet, headerText, {
    rowStart: 8,
    rowEnd: 10,
  });

  return fallback ? fallback.columnNumber : null;
}

function applyHighlighting(worksheet) {
  let highlightCount = 0;
  const columns = HIGHLIGHT_HEADERS.map((header) => findHighlightColumn(worksheet, header)).filter(Boolean);

  columns.forEach((columnNumber) => {
    for (let rowNumber = 11; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      const cell = worksheet.getRow(rowNumber).getCell(columnNumber);

      if (!isValueExactly150(cell.value)) {
        continue;
      }

      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFFC7CE' },
      };
      cell.font = {
        ...(cell.font || {}),
        color: { argb: 'FF9C0006' },
      };
      highlightCount += 1;
    }
  });

  return highlightCount;
}

function applyBorders(worksheet, tableRange) {
  if (!tableRange) {
    return;
  }

  const border = {
    style: 'thin',
    color: { argb: 'FF000000' },
  };

  for (let rowNumber = tableRange.startRow; rowNumber <= tableRange.endRow; rowNumber += 1) {
    for (let columnNumber = tableRange.startCol; columnNumber <= tableRange.endCol; columnNumber += 1) {
      worksheet.getRow(rowNumber).getCell(columnNumber).border = {
        top: border,
        left: border,
        bottom: border,
        right: border,
      };
    }
  }
}

function getHeaderRowsForVariant(variant) {
  return variant === 'summary' ? SUMMARY_HEADER_ROWS : INDIVIDUAL_HEADER_ROWS;
}

// Mirrors SXTransformSummary.detectFinalTableRange / SXTransformIndiv.detectFinalTableRange:
// individual reports bound the table between the 'ลำดับที่' and 'หมายเหตุ' headers, while
// summary reports use the full used-range width (no natural start/end header pair).
function detectFinalTableRange(worksheet, model, bounds, variant) {
  const headerRows = getHeaderRowsForVariant(variant);
  let startCol = bounds.left;
  let endCol = bounds.right;

  if (variant === 'individual') {
    const startMatch = findColumnByHeaderText(worksheet, 'ลำดับที่', {
      rowStart: Math.min(...headerRows),
      rowEnd: Math.max(...headerRows),
      left: bounds.left,
      right: bounds.right,
    });
    const endMatch = findColumnByHeaderText(worksheet, 'หมายเหตุ', {
      rowStart: Math.min(...headerRows),
      rowEnd: Math.max(...headerRows),
      left: bounds.left,
      right: bounds.right,
    });

    if (!startMatch || !endMatch) {
      return null;
    }

    startCol = startMatch.start;
    endCol = endMatch.start + endMatch.count - 1;
  }

  const startRow = findFirstHeaderRowInRange(model, startCol, endCol, headerRows);
  if (!startRow) {
    return null;
  }

  const dataStartRow = Math.max(...headerRows) + 1;
  const endRow = Math.max(
    findLastNonEmptyRowInRange(worksheet, startCol, endCol, dataStartRow, getCellText) || 0,
    Math.max(...headerRows),
  );

  return { startCol, endCol, startRow, dataStartRow, endRow };
}

function applyColumnWidths(worksheet, tableRange, bounds, variant) {
  const model = buildSheetModel(worksheet, getCellText);
  const headerRows = getHeaderRowsForVariant(variant);
  const sizingRange = tableRange
    ? { top: tableRange.startRow, bottom: tableRange.endRow, left: tableRange.startCol, right: tableRange.endCol }
    : bounds;
  const fixedColumnWidths = variant === 'individual' ? FORMATTING_CONFIG.INDIVIDUAL_FIXED_COLUMN_WIDTHS : null;

  let columnWidths = calculateColumnWidths(model, sizingRange, { headerRows, fixedColumnWidths });
  columnWidths = fitColumnWidthsToPrintableWidth(columnWidths, sizingRange);
  applyCalculatedColumnWidths(worksheet, columnWidths);

  return { model, sizingRange, columnWidths };
}

function applyRowHeights(worksheet, model, bounds, columnWidths, variant) {
  const headerRows = getHeaderRowsForVariant(variant);
  const fixedRowHeights = variant === 'individual' ? FORMATTING_CONFIG.INDIVIDUAL_FIXED_ROW_HEIGHTS : null;
  applyCalculatedRowHeights(worksheet, model, bounds, columnWidths, { headerRows, fixedRowHeights });
}

async function loadWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  if (!workbook.worksheets.length) {
    const error = new Error('Workbook must contain at least one worksheet.');
    error.statusCode = 400;
    throw error;
  }

  return workbook;
}

async function transformWorkbook(buffer, options) {
  const workbook = await loadWorkbook(buffer);
  const worksheet = workbook.worksheets[0];
  const warnings = [];
  const detectedVariant = detectWorkbookVariant(worksheet);
  const effectiveVariant = options.requestedVariant || detectedVariant;

  if (options.requestedVariant && options.requestedVariant !== detectedVariant) {
    warnings.push(
      `Selected formatter "${options.requestedVariant}" but the workbook looked like "${detectedVariant}". Continuing with the selected formatter.`,
    );
  }

  const headerRows = getHeaderRowsForVariant(effectiveVariant);

  applyWorkbookFont(worksheet);
  wrapHeaderRows(worksheet, headerRows);

  const deletedColumns =
    effectiveVariant === 'summary'
      ? collectSummaryColumnMatches(worksheet, warnings)
      : collectIndividualColumnMatches(worksheet, warnings);

  if (deletedColumns.length) {
    deleteColumns(worksheet, deletedColumns);
  }

  applyWorkbookFont(worksheet);
  wrapHeaderRows(worksheet, headerRows);

  // worksheet.columnCount does not shrink after spliceColumns (only actualColumnCount does),
  // so relying on columnCount here after a column deletion would size/border/scan a range
  // that includes stale, already-deleted trailing columns.
  const bounds = { top: 1, left: 1, bottom: worksheet.rowCount, right: worksheet.actualColumnCount };
  const preliminaryModel = buildSheetModel(worksheet, getCellText);
  const tableRange = detectFinalTableRange(worksheet, preliminaryModel, bounds, effectiveVariant);

  if (!tableRange) {
    warnings.push('Could not detect the final table range for column sizing and border styling.');
  }

  const { model, columnWidths } = applyColumnWidths(worksheet, tableRange, bounds, effectiveVariant);
  applyRowHeights(worksheet, model, bounds, columnWidths, effectiveVariant);

  const highlightCount = effectiveVariant === 'individual' ? applyHighlighting(worksheet) : 0;
  if (effectiveVariant === 'individual') {
    applyBorders(worksheet, tableRange);
  }

  worksheet.views = [{ state: 'frozen', ySplit: Math.max(...headerRows) }];

  workbook.worksheets
    .filter((sheet) => sheet.id !== worksheet.id)
    .forEach((sheet) => workbook.removeWorksheet(sheet.id));

  return {
    workbook,
    worksheet,
    detectedVariant,
    effectiveVariant,
    warnings,
    deletedColumns,
    highlightCount,
  };
}

function copyWorksheet(sourceWorksheet, targetWorkbook, sheetName) {
  const targetWorksheet = targetWorkbook.addWorksheet(sheetName);

  sourceWorksheet.eachRow({ includeEmpty: true }, (sourceRow, rowNumber) => {
    const targetRow = targetWorksheet.getRow(rowNumber);
    targetRow.height = sourceRow.height;

    sourceRow.eachCell({ includeEmpty: true }, (sourceCell, columnNumber) => {
      const targetCell = targetRow.getCell(columnNumber);
      targetCell.value = sourceCell.value;
      targetCell.style = JSON.parse(JSON.stringify(sourceCell.style || {}));
    });
  });

  sourceWorksheet.columns.forEach((sourceColumn, index) => {
    targetWorksheet.getColumn(index + 1).width = sourceColumn.width;
  });

  return targetWorksheet;
}

module.exports = {
  copyWorksheet,
  loadWorkbook,
  transformWorkbook,
};
