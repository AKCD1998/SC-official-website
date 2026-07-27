const ExcelJS = require("exceljs");
const {
  HIGHLIGHT_HEADERS,
  TARGET_HEADERS_TO_DELETE,
  findColumnByHeaderText,
  getCellText,
  normalizeHeaderText,
} = require("./workbookRules");

function detectWorkbookVariant(worksheet) {
  const sheetName = normalizeHeaderText(worksheet.name).toLowerCase();
  if (sheetName === "summary" || sheetName === "sum") {
    return "summary";
  }

  const atkMatch = findColumnByHeaderText(worksheet, "ATK", {
    rowStart: 5,
    rowEnd: 5,
  });

  return atkMatch ? "summary" : "individual";
}

function applyWorkbookFont(worksheet) {
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      cell.font = {
        ...(cell.font || {}),
        name: "AngsanaUPC",
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
        vertical: "middle",
      };
    });
  });
}

function deleteColumns(worksheet, matches) {
  matches
    .slice()
    .sort((left, right) => right.start - left.start)
    .forEach((match) => {
      worksheet.spliceColumns(match.start, match.count);
    });
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
  const match = findColumnByHeaderText(worksheet, "ATK", {
    rowStart: 5,
    rowEnd: 5,
  });

  if (!match) {
    warnings.push('Could not find header "ATK" for column deletion.');
    return [];
  }

  return [
    {
      headerText: "ATK and columns to the right",
      matchedText: match.matchedText,
      strategy: `${match.strategy}-to-right`,
      start: match.start,
      count: Math.max(1, worksheet.columnCount - match.start + 1),
      columnLabel: `${match.start}:${worksheet.columnCount}`,
    },
  ];
}

function isValueExactly150(value) {
  if (value === null || typeof value === "undefined" || value instanceof Date) {
    return false;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) && value === 150;
  }

  return /^150(?:\.0+)?$/.test(String(value).replace(/,/g, "").trim());
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
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFFFC7CE" },
      };
      cell.font = {
        ...(cell.font || {}),
        color: { argb: "FF9C0006" },
      };
      highlightCount += 1;
    }
  });

  return highlightCount;
}

function applyBorders(worksheet) {
  const startMatch = findColumnByHeaderText(worksheet, "ลำดับที่", {
    rowStart: 8,
    rowEnd: 10,
  });
  const endMatch = findColumnByHeaderText(worksheet, "หมายเหตุ", {
    rowStart: 8,
    rowEnd: 10,
  });

  if (!startMatch || !endMatch) {
    return;
  }

  const border = {
    style: "thin",
    color: { argb: "FF000000" },
  };
  const startRow = Math.min(startMatch.rowNumber, endMatch.rowNumber, 8);
  const endRow = worksheet.rowCount;

  for (let rowNumber = startRow; rowNumber <= endRow; rowNumber += 1) {
    for (let columnNumber = startMatch.columnNumber; columnNumber <= endMatch.columnNumber; columnNumber += 1) {
      worksheet.getRow(rowNumber).getCell(columnNumber).border = {
        top: border,
        left: border,
        bottom: border,
        right: border,
      };
    }
  }
}

function applyColumnWidths(worksheet) {
  for (let columnNumber = 1; columnNumber <= worksheet.columnCount; columnNumber += 1) {
    let maxWidth = 6;

    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const text = getCellText(worksheet, row.number, columnNumber);
      if (text) {
        maxWidth = Math.max(maxWidth, Math.min(24, text.length * 0.9 + 2));
      }
    });

    worksheet.getColumn(columnNumber).width = maxWidth;
  }
}

function applyRowHeights(worksheet, variant) {
  if (variant === "individual") {
    [8, 9, 10].forEach((rowNumber) => {
      worksheet.getRow(rowNumber).height = 15;
    });
  }
}

async function loadWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  if (!workbook.worksheets.length) {
    const error = new Error("Workbook must contain at least one worksheet.");
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

  applyWorkbookFont(worksheet);
  wrapHeaderRows(worksheet, effectiveVariant === "summary" ? [5, 6, 7, 8, 9, 10] : [8, 9, 10]);

  const deletedColumns =
    effectiveVariant === "summary"
      ? collectSummaryColumnMatches(worksheet, warnings)
      : collectIndividualColumnMatches(worksheet, warnings);

  if (deletedColumns.length) {
    deleteColumns(worksheet, deletedColumns);
    warnings.push("Column deletion was applied with the Node workbook strategy; merged-range parity must be verified against real samples.");
  }

  applyWorkbookFont(worksheet);
  wrapHeaderRows(worksheet, effectiveVariant === "summary" ? [5, 6, 7, 8, 9, 10] : [8, 9, 10]);
  applyColumnWidths(worksheet);
  applyRowHeights(worksheet, effectiveVariant);

  const highlightCount = effectiveVariant === "individual" ? applyHighlighting(worksheet) : 0;
  if (effectiveVariant === "individual") {
    applyBorders(worksheet);
  }

  worksheet.views = [{ state: "frozen", ySplit: 10 }];

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
