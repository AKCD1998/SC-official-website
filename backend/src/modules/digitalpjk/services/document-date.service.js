import { pool } from "../db/pool.js";

const THAI_MONTH_NAMES = [
  "มกราคม",
  "กุมภาพันธ์",
  "มีนาคม",
  "เมษายน",
  "พฤษภาคม",
  "มิถุนายน",
  "กรกฎาคม",
  "สิงหาคม",
  "กันยายน",
  "ตุลาคม",
  "พฤศจิกายน",
  "ธันวาคม",
];

function toIsoDate(dateValue) {
  const year = dateValue.getFullYear();
  const month = String(dateValue.getMonth() + 1).padStart(2, "0");
  const day = String(dateValue.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateOnlyString(dateOnly) {
  if (typeof dateOnly !== "string") {
    return null;
  }

  const match = dateOnly.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (!year || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  return new Date(year, month - 1, day);
}

function formatThaiDate(dateValue) {
  const monthIndex = dateValue.getMonth();
  return {
    day: dateValue.getDate(),
    monthNameTh: THAI_MONTH_NAMES[monthIndex],
    yearBE: dateValue.getFullYear() + 543,
  };
}

export async function getGlobalSettingsRow(clientArg = null) {
  const ownsClient = !clientArg;
  const client = clientArg || (await pool.connect());

  try {
    const existing = await client.query(
      `
      SELECT
        id,
        use_system_date,
        forced_date,
        updated_by,
        updated_at
      FROM global_settings
      WHERE id = 1
      LIMIT 1;
      `
    );

    if (existing.rowCount > 0) {
      return existing.rows[0];
    }

    const inserted = await client.query(
      `
      INSERT INTO global_settings (
        id,
        use_system_date,
        forced_date,
        updated_by
      )
      VALUES (1, TRUE, NULL, NULL)
      RETURNING
        id,
        use_system_date,
        forced_date,
        updated_by,
        updated_at;
      `
    );

    return inserted.rows[0];
  } finally {
    if (ownsClient) {
      client.release();
    }
  }
}

export function buildDocumentDateFromSettings(settingsRow) {
  const forcedDateValue =
    settingsRow?.forced_date instanceof Date
      ? settingsRow.forced_date
      : parseDateOnlyString(settingsRow?.forced_date || "");

  const useForcedDate = settingsRow?.use_system_date === false && Boolean(forcedDateValue);
  const effectiveDate = useForcedDate ? forcedDateValue : new Date();

  return {
    mode: useForcedDate ? "forced" : "system",
    dateISO: toIsoDate(effectiveDate),
    thai: formatThaiDate(effectiveDate),
  };
}

export async function getCurrentDocumentDate(clientArg = null) {
  const settingsRow = await getGlobalSettingsRow(clientArg);
  return buildDocumentDateFromSettings(settingsRow);
}

export function mapGlobalSettings(settingsRow) {
  const forcedDate =
    settingsRow.forced_date instanceof Date
      ? toIsoDate(settingsRow.forced_date)
      : settingsRow.forced_date ?? null;

  return {
    useSystemDate: settingsRow.use_system_date,
    forcedDate,
    updatedBy: settingsRow.updated_by ?? null,
    updatedAt: settingsRow.updated_at,
  };
}

export function normalizeForcedDateInput(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return null;
  }

  if (typeof rawValue !== "string") {
    return null;
  }

  const parsed = parseDateOnlyString(rawValue);
  if (!parsed) {
    return null;
  }

  return toIsoDate(parsed);
}
