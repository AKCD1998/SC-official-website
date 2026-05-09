import { httpError } from "./httpError.js";

function toCleanText(value) {
  return String(value ?? "").trim();
}

function toIsoDate(year, month, day, fieldName) {
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const isoDate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    throw httpError(400, `${fieldName} must be a valid date`);
  }

  return isoDate;
}

export function parseDateOnlyInput(value, fieldName = "date", { allowEmpty = true } = {}) {
  const text = toCleanText(value);
  if (!text) {
    if (allowEmpty) return "";
    throw httpError(400, `${fieldName} is required`);
  }

  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return toIsoDate(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]), fieldName);
  }

  const displayMatch = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (displayMatch) {
    return toIsoDate(
      Number(displayMatch[3]),
      Number(displayMatch[2]),
      Number(displayMatch[1]),
      fieldName
    );
  }

  throw httpError(400, `${fieldName} must be in YYYY-MM-DD or DD/MM/YYYY format`);
}

export function formatDateOnlyDisplay(value) {
  const isoDate = parseDateOnlyInput(value, "date", { allowEmpty: true });
  if (!isoDate) return "";
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
}
