const ExcelJS = require('exceljs');
const {
  HIGHLIGHT_HEADERS,
  TARGET_HEADERS_TO_DELETE,
  buildOutputFilename,
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
  columnLetter,
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

// The legacy GAS pipeline never set this in code — no `pageSetup`/`orientation`/`landscape`
// call exists anywhere in that source. Real legacy reference output files (verified directly)
// all have orientation: 'landscape', fitToPage: false, fitToWidth/fitToHeight: 1, scale: 100,
// paperSize: 9 (A4), margins 0.7/0.7/0.75/0.75 with header/footer 0 — so this was almost
// certainly baked into a manually pre-configured Google Sheets print-settings dialog on a
// template, which Sheets' own xlsx exporter then serialized automatically. The worksheet here
// is loaded from the raw uploaded file's own bytes, whose pageSetup is sparse (only
// fitToPage/margins, no orientation/fitToWidth/fitToHeight/scale at all) — set every field
// explicitly rather than relying on the OOXML spec's implicit defaults for the missing ones.
function applyPageSetup(worksheet) {
  worksheet.pageSetup = {
    ...worksheet.pageSetup,
    orientation: 'landscape',
    paperSize: 9, // A4
    fitToPage: false,
    fitToWidth: 1,
    fitToHeight: 1,
    scale: 100,
    margins: {
      ...worksheet.pageSetup.margins,
      left: 0.7,
      right: 0.7,
      top: 0.75,
      bottom: 0.75,
      header: 0,
      footer: 0,
    },
  };
}

// buildOutputFilename() already resolves branchCode/parsedDate per variant (HCODE-column scan
// for individual, C3/C11 or fallback scan for summary) — reused here rather than re-deriving,
// so the title always agrees with whatever the actual output filename says.
function formatDisplayDate(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || '');
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
}

function buildReportTitleText(worksheet, variant) {
  // originalFilename only affects buildOutputFilename's fallback *filename* string, which we
  // never read here — only .branchCode/.parsedDate — so a fixed placeholder is fine.
  const metadata = buildOutputFilename(worksheet, 'workbook.xlsx', variant);
  const label = variant === 'summary' ? 'สรุป' : 'รายคน';
  const branchPart = metadata.branchCode ? `สาขา ${metadata.branchCode}` : '';
  const datePart = metadata.parsedDate ? `วันที่ ${formatDisplayDate(metadata.parsedDate)}` : '';

  return [label, branchPart, datePart].filter(Boolean).join(' ');
}

// So the accountant can immediately tell what a document is without opening the row-8+ table.
// Positioned to the right of the existing B2:C5-ish metadata block, rows 1-N — N stops one row
// before each variant's real header table starts (row 8 for individual, row 5 for summary), so
// it never overlaps real header content. Spans dynamically to the sheet's actual last column
// rather than a hardcoded letter, since individual/summary end at different columns.
function applyReportTitle(worksheet, variant, bounds, warnings) {
  try {
    const startColumn = 8; // column H — clear of the metadata labels/values in columns B-C
    const endRow = variant === 'summary' ? 4 : 5;
    const endColumn = Math.max(startColumn, bounds.right);
    const titleText = buildReportTitleText(worksheet, variant);

    if (!titleText) {
      return;
    }

    const range = `${columnLetter(startColumn)}1:${columnLetter(endColumn)}${endRow}`;
    worksheet.mergeCells(range);

    const cell = worksheet.getCell(`${columnLetter(startColumn)}1`);
    cell.value = titleText;
    cell.font = { bold: true, size: 48, name: 'AngsanaUPC' };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  } catch (error) {
    // Cosmetic addition — never let it break the actual document processing.
    warnings.push(`Could not add the report title banner: ${error.message}`);
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
  applyPageSetup(worksheet);
  applyReportTitle(worksheet, effectiveVariant, bounds, warnings);

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

  // Copying cell values/styles above does not carry merged ranges — a merged header cell's
  // "echoed" value read from its non-master cells gets copied as an independent literal value
  // into every cell of the range, which then renders as a real, un-merged, visually duplicated
  // header in the preview workbook (the actual multi-row header collapses into one merged cell
  // in every other output, since only the preview workbook goes through copyWorksheet).
  (sourceWorksheet.model.merges || []).forEach((range) => {
    targetWorksheet.mergeCells(range);
  });

  // Same gap as merges: pageSetup (landscape orientation, margins, scale) and the frozen-pane
  // view are worksheet-level properties, not per-cell — copying cells/columns/merges above never
  // carries them, so the preview workbook (the file users actually see/print first) silently
  // reverted to Portrait even though the processed_xlsx output (built directly on the source
  // worksheet, no copy involved) was correctly landscape.
  targetWorksheet.pageSetup = JSON.parse(JSON.stringify(sourceWorksheet.pageSetup || {}));
  targetWorksheet.views = JSON.parse(JSON.stringify(sourceWorksheet.views || []));

  return targetWorksheet;
}

module.exports = {
  copyWorksheet,
  loadWorkbook,
  transformWorkbook,
};
