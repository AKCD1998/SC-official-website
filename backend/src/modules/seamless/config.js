const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function readSchemaName() {
  const schemaName = String(
    process.env.SEAMLESS_DB_SCHEMA || process.env.DB_SCHEMA || "clasp_scx_seamless",
  ).trim();

  if (!IDENTIFIER_PATTERN.test(schemaName)) {
    const error = new Error(`Invalid Seamless schema name: ${schemaName}`);
    error.statusCode = 500;
    throw error;
  }

  return schemaName;
}

function readInternalApiToken() {
  return String(
    process.env.SEAMLESS_INTERNAL_API_TOKEN || process.env.INTERNAL_API_TOKEN || "",
  ).trim();
}

function readAppBasicCredentials() {
  return {
    user: String(process.env.SEAMLESS_APP_BASIC_USER || "").trim(),
    password: String(process.env.SEAMLESS_APP_BASIC_PASSWORD || "").trim(),
  };
}

function readAutoPrintSince() {
  return String(process.env.SEAMLESS_AUTO_PRINT_SINCE || "").trim();
}

function readLineConfig() {
  return {
    channelAccessToken: String(process.env.SEAMLESS_LINE_CHANNEL_ACCESS_TOKEN || "").trim(),
    channelSecret: String(process.env.SEAMLESS_LINE_CHANNEL_SECRET || "").trim(),
    targetId: String(process.env.SEAMLESS_LINE_TARGET_ID || "").trim(),
  };
}

// Prefers the dedicated SEAMLESS_R2_* vars, but falls back to this Render service's existing
// bare R2_* vars (already configured for the slider-image feature) so a working R2 setup
// doesn't require adding brand-new env vars. SEAMLESS_R2_KEY_PREFIX still applies on top
// regardless of which credential set is used, so Seamless's objects stay isolated by key path
// even when sharing a bucket with slider images.
function readR2Config() {
  return {
    endpoint: String(process.env.SEAMLESS_R2_ENDPOINT || process.env.R2_ENDPOINT || "").trim(),
    accessKeyId: String(
      process.env.SEAMLESS_R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || "",
    ).trim(),
    secretAccessKey: String(
      process.env.SEAMLESS_R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || "",
    ).trim(),
    bucket: String(
      process.env.SEAMLESS_R2_BUCKET || process.env.R2_BUCKET || process.env.R2_BUCKET_NAME || "",
    ).trim(),
    keyPrefix: String(process.env.SEAMLESS_R2_KEY_PREFIX || "clasp-scx-seamless").trim(),
    forcePathStyle: ["1", "true", "yes", "on"].includes(
      String(process.env.SEAMLESS_R2_FORCE_PATH_STYLE || "").trim().toLowerCase(),
    ),
  };
}

function readStorageDir() {
  return String(process.env.SEAMLESS_STORAGE_DIR || "storage/seamless").trim();
}

function readPublicBaseUrl() {
  return String(process.env.SEAMLESS_PUBLIC_BASE_URL || "").trim();
}

function readEmailConfig() {
  return {
    sendgridApiKey: String(process.env.SENDGRID_API_KEY || "").trim(),
    mailFrom: String(process.env.MAIL_USER || process.env.SEAMLESS_MAIL_FROM || "").trim(),
    docsRecipientEmail: String(process.env.SEAMLESS_DOCS_RECIPIENT_EMAIL || "").trim(),
  };
}

module.exports = {
  readAppBasicCredentials,
  readAutoPrintSince,
  readEmailConfig,
  readInternalApiToken,
  readLineConfig,
  readPublicBaseUrl,
  readR2Config,
  readSchemaName,
  readStorageDir,
};
