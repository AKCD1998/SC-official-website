const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function normalizeText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

export function readScGlamLiffEnv(name, defaultValue = "") {
  const value = normalizeText(process.env[name]);
  return value || defaultValue;
}

export function requireScGlamLiffEnv(name) {
  const value = readScGlamLiffEnv(name);
  if (!value) {
    const error = new Error(`${name} is not set`);
    error.status = 503;
    error.code = "SCGLAMLIFF_CONFIG_MISSING";
    error.envName = name;
    throw error;
  }
  return value;
}

export function readBooleanScGlamLiffEnv(name) {
  return TRUE_VALUES.has(readScGlamLiffEnv(name).toLowerCase());
}

export function isProductionRuntime() {
  return normalizeText(process.env.NODE_ENV).toLowerCase() === "production";
}

export function getDatabaseUrl() {
  return readScGlamLiffEnv("SCGLAMLIFF_DATABASE_URL");
}

export function getPgSslMode() {
  return readScGlamLiffEnv("SCGLAMLIFF_PGSSLMODE");
}

export function getJwtSecret() {
  return requireScGlamLiffEnv("SCGLAMLIFF_JWT_SECRET");
}

export function getOptionalJwtSecret() {
  return readScGlamLiffEnv("SCGLAMLIFF_JWT_SECRET");
}

export function getDefaultBranchId() {
  return readScGlamLiffEnv("SCGLAMLIFF_DEFAULT_BRANCH_ID", "branch-003");
}

export function isLegacySheetModeEnabled() {
  return readBooleanScGlamLiffEnv("SCGLAMLIFF_LEGACY_SHEET_MODE");
}

export function getPinFingerprintSecret() {
  return (
    readScGlamLiffEnv("SCGLAMLIFF_PIN_FINGERPRINT_SECRET") ||
    readScGlamLiffEnv("SCGLAMLIFF_JWT_SECRET")
  );
}

export function getGasAppointmentsUrl() {
  return readScGlamLiffEnv("SCGLAMLIFF_GAS_APPOINTMENTS_URL");
}

export function getGasSecret() {
  return readScGlamLiffEnv("SCGLAMLIFF_GAS_SECRET");
}

export function getLineLiffChannelId() {
  return (
    readScGlamLiffEnv("SCGLAMLIFF_LINE_CHANNEL_ID") ||
    readScGlamLiffEnv("SCGLAMLIFF_LINE_LIFF_CHANNEL_ID")
  );
}

export { normalizeText };
