function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year, month) {
  const DAYS = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return DAYS[month - 1];
}

function lastDayOfMonth(year, month) {
  return daysInMonth(year, month);
}

// Matches attachment filenames such as MRR2602-1-HSPCP00533.pdf / SFR2602-2-HSPCP00533.pdf.
// -1- covers the 01-15 half of the month, -2- covers 16 through the real last day of the month.
const SETTLEMENT_FILENAME_PATTERN = /^(MRR|SFR)(\d{2})(\d{2})-([12])-([A-Za-z0-9]+)\.pdf$/i;

function parseSettlementFilename(filename) {
  const match = SETTLEMENT_FILENAME_PATTERN.exec(String(filename || "").trim());
  if (!match) {
    return null;
  }

  const [, reportPrefix, yy, mm, half, partnerCode] = match;
  const gregorianYear = 2000 + Number(yy);
  const month = Number(mm);

  if (month < 1 || month > 12) {
    return null;
  }

  const halfLabel = half === "1" ? "H1" : "H2";
  const periodStartDay = half === "1" ? 1 : 16;
  const periodEndDay = half === "1" ? 15 : lastDayOfMonth(gregorianYear, month);
  const pad = (value) => String(value).padStart(2, "0");

  return {
    reportPrefix: reportPrefix.toUpperCase(),
    half: halfLabel,
    partnerCode: partnerCode.toUpperCase(),
    periodStart: `${gregorianYear}-${pad(month)}-${pad(periodStartDay)}`,
    periodEnd: `${gregorianYear}-${pad(month)}-${pad(periodEndDay)}`,
    cycleKey: `${gregorianYear}-${pad(month)}-${halfLabel}`,
  };
}

// Matches attachment filenames such as CIV2602000123.pdf.
const CIV_FILENAME_PATTERN = /^(CIV[A-Za-z0-9-]+)\.pdf$/i;

function parseCivFilename(filename) {
  const match = CIV_FILENAME_PATTERN.exec(String(filename || "").trim());
  if (!match) {
    return null;
  }

  return { documentNumber: match[1].toUpperCase() };
}

module.exports = {
  daysInMonth,
  isLeapYear,
  lastDayOfMonth,
  parseCivFilename,
  parseSettlementFilename,
};
