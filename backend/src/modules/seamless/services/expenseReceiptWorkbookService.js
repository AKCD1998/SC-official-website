const ExcelJS = require("exceljs");
const { badRequest } = require("../errors");

const EXPECTED_SHEET_TITLE = "ใบสำคัญรับเงิน";

function valueResult(value) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "result")) {
    return value.result;
  }
  return value;
}

function cellText(cell) {
  const value = valueResult(cell && cell.value);
  if (value === null || typeof value === "undefined") return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text.trim();
    if (Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text || "").join("").trim();
    }
  }
  return String(value).trim();
}

function cellNumber(cell) {
  const value = valueResult(cell && cell.value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(String(value || "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeThaiName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/^(นาย|นางสาว|นาง|ภก\.|ภญ\.|เภสัชกร)\s*/u, "")
    .replace(/[().\s]/g, "")
    .trim();
}

function workbookDateToIso(value) {
  const resolved = valueResult(value);
  if (!(resolved instanceof Date) || Number.isNaN(resolved.getTime())) return "";

  let year = resolved.getUTCFullYear();
  if (year >= 2400) year -= 543;
  const month = String(resolved.getUTCMonth() + 1).padStart(2, "0");
  const day = String(resolved.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseShortDate(value) {
  const match = String(value || "").match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  return match ? `20${match[3]}-${match[2]}-${match[1]}` : "";
}

function itemDates(description) {
  const matches = String(description || "").match(/\d{2}\/\d{2}\/\d{2}/g) || [];
  return {
    transactionDate: parseShortDate(matches[0]),
    postingDate: parseShortDate(matches[1]),
  };
}

function itemMatchesPeriod(item, expensePeriod) {
  return [item.transactionDate, item.postingDate].some((date) => date.startsWith(`${expensePeriod}-`));
}

async function inspectExpenseReceiptWorkbook(buffer, options = {}) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw badRequest("The uploaded file is not a readable .xlsx workbook.");
  }

  const worksheet = workbook.getWorksheet(EXPECTED_SHEET_TITLE) || workbook.worksheets[0];
  if (!worksheet || !cellText(worksheet.getCell("A1")).includes(EXPECTED_SHEET_TITLE)) {
    throw badRequest("The workbook is not an expense receipt (ใบสำคัญรับเงิน).");
  }

  const items = [];
  for (let rowNumber = 12; rowNumber <= 31; rowNumber += 1) {
    const description = cellText(worksheet.getCell(`C${rowNumber}`));
    const baht = cellNumber(worksheet.getCell(`I${rowNumber}`));
    const satang = cellNumber(worksheet.getCell(`K${rowNumber}`));
    const amount = Math.round((baht + satang / 100) * 100) / 100;
    if (!description && amount === 0) continue;
    items.push({ rowNumber, description, amount, ...itemDates(description) });
  }

  const totalFromItems = Math.round(items.reduce((sum, item) => sum + item.amount, 0) * 100) / 100;
  const totalFromFormula = Math.round(cellNumber(worksheet.getCell("N1")) * 100) / 100;
  const totalAmount = totalFromFormula || totalFromItems;
  const claimantName = cellText(worksheet.getCell("G38")) || cellText(worksheet.getCell("B6"));
  const warnings = [];

  if (!claimantName) throw badRequest("The expense receipt does not identify the claimant.");
  if (!items.length || totalAmount <= 0) {
    throw badRequest("The expense receipt does not contain a positive claim amount.");
  }
  if (Math.abs(totalAmount - totalFromItems) > 0.005) {
    warnings.push({
      code: "TOTAL_MISMATCH",
      message: "The displayed total does not match the sum of the populated expense rows.",
      displayedTotal: totalAmount,
      calculatedTotal: totalFromItems,
    });
  }

  const expensePeriod = String(options.expensePeriod || "").trim();
  if (expensePeriod) {
    const rows = items.filter((item) => !itemMatchesPeriod(item, expensePeriod)).map((item) => item.rowNumber);
    if (rows.length) {
      warnings.push({
        code: "ITEMS_OUTSIDE_EXPENSE_PERIOD",
        message: "Some populated rows contain transaction and posting dates outside the stated expense period.",
        rows,
      });
    }
  }

  const expectedClaimantName = String(options.expectedClaimantName || "").trim();
  if (expectedClaimantName && normalizeThaiName(expectedClaimantName) !== normalizeThaiName(claimantName)) {
    throw badRequest("The claimant in the workbook does not match expectedClaimantName.", {
      expectedClaimantName,
      workbookClaimantName: claimantName,
    });
  }

  const dates = items.flatMap((item) => [item.transactionDate, item.postingDate]).filter(Boolean).sort();
  return {
    sheetName: worksheet.name,
    documentTitle: EXPECTED_SHEET_TITLE,
    documentDate: workbookDateToIso(worksheet.getCell("H4").value),
    claimantName,
    payerName: cellText(worksheet.getCell("C8")),
    totalAmount,
    totalFromItems,
    amountInWords: cellText(worksheet.getCell("C34")),
    itemCount: items.length,
    firstExpenseDate: dates[0] || "",
    lastExpenseDate: dates[dates.length - 1] || "",
    hasRecipientSignature: typeof worksheet.getImages === "function" && worksheet.getImages().length > 0,
    printArea: worksheet.pageSetup && worksheet.pageSetup.printArea ? worksheet.pageSetup.printArea : "",
    fitToWidth: worksheet.pageSetup && worksheet.pageSetup.fitToWidth,
    warnings,
    items,
  };
}

module.exports = { EXPECTED_SHEET_TITLE, inspectExpenseReceiptWorkbook, normalizeThaiName };
