const { badRequest } = require("./errors");

function normalizeString(value) {
  if (value === null || typeof value === "undefined") {
    return "";
  }

  return String(value).trim();
}

function requireString(value, message) {
  const normalized = normalizeString(value);

  if (!normalized) {
    throw badRequest(message);
  }

  return normalized;
}

function parseFormatterMode(value, options = {}) {
  const normalized = normalizeString(value).toLowerCase();

  if (!normalized) {
    return options.allowEmpty ? null : "individual";
  }

  if (normalized === "individual" || normalized === "indiv") {
    return "individual";
  }

  if (normalized === "summary" || normalized === "sum") {
    return "summary";
  }

  throw badRequest("The selected formatter mode is not supported.", {
    formatterMode: value,
  });
}

function normalizeBoolean(value) {
  if (value === null || typeof value === "undefined" || String(value).trim() === "") {
    return null;
  }

  if (value === true || value === false) {
    return value;
  }

  return ["true", "1", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function normalizeReportDateKey(value) {
  const text = normalizeString(value);

  if (!text) {
    return "";
  }

  const dashedMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dashedMatch) {
    return `${dashedMatch[1]}${dashedMatch[2]}${dashedMatch[3]}`;
  }

  if (/^\d{8}$/.test(text)) {
    return text;
  }

  return "";
}

function normalizeLimit(value, fallback = 100) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(parsed), 500);
}

function normalizeBranchCodes(value) {
  const rawValues = [];

  if (value === null || typeof value === "undefined") {
    return "";
  }

  if (Array.isArray(value)) {
    value.forEach((item) => {
      rawValues.push(...String(item || "").split(/[,;\s]+/));
    });
  } else {
    rawValues.push(...String(value || "").split(/[,;\s]+/));
  }

  const seen = new Set();
  const branchCodes = [];

  rawValues.forEach((rawValue) => {
    const branchCode = normalizeString(rawValue);

    if (!/^\d{3}$/.test(branchCode) || seen.has(branchCode)) {
      return;
    }

    seen.add(branchCode);
    branchCodes.push(branchCode);
  });

  branchCodes.sort((left, right) => Number(left) - Number(right) || left.localeCompare(right));

  return branchCodes.join(", ");
}

function reportDateKeyToDate(reportDateKey) {
  const normalized = normalizeReportDateKey(reportDateKey);

  if (!normalized) {
    return null;
  }

  return `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}`;
}

function todayReportDateKey() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return `${now.getFullYear()}${month}${day}`;
}

function extractReportDateFromText(value) {
  const text = normalizeString(value);
  const dashedMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);

  if (dashedMatch) {
    return `${dashedMatch[1]}${dashedMatch[2]}${dashedMatch[3]}`;
  }

  const compactMatch = text.match(/(?:^|[^0-9])(\d{8})(?:[^0-9]|$)/);

  return compactMatch ? compactMatch[1] : "";
}

function coerceReportDateKey(...values) {
  for (const value of values) {
    const normalized = normalizeReportDateKey(value) || extractReportDateFromText(value);
    if (normalized) {
      return normalized;
    }
  }

  return todayReportDateKey();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    normalizeString(value),
  );
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeString(value));
}

module.exports = {
  coerceReportDateKey,
  isUuid,
  isValidEmail,
  normalizeBoolean,
  normalizeBranchCodes,
  normalizeLimit,
  normalizeReportDateKey,
  normalizeString,
  parseFormatterMode,
  reportDateKeyToDate,
  requireString,
};
