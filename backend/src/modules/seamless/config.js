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

// SEAMLESS_APP_BASIC_USER accepts a comma-separated list (e.g. multiple staff usernames sharing
// one password) as well as a single username — both resolve to the "user" role. Blank entries
// from stray commas/whitespace are dropped.
function readAppBasicCredentials() {
  const users = String(process.env.SEAMLESS_APP_BASIC_USER || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    users,
    password: String(process.env.SEAMLESS_APP_BASIC_PASSWORD || "").trim(),
  };
}

// A second, separate credential pair for admin-level access (sees classification diagnostics,
// document numbers, routing/status columns; regular users get a stripped-down view — see
// appAuth.js and pharmcareController.js). Optional: if unset, only the regular pair exists and
// nobody gets the admin role, same as today.
function readAppAdminBasicCredentials() {
  return {
    user: String(process.env.SEAMLESS_APP_ADMIN_BASIC_USER || "").trim(),
    password: String(process.env.SEAMLESS_APP_ADMIN_BASIC_PASSWORD || "").trim(),
  };
}

// No dedicated SEAMLESS_SESSION_SECRET needs to be provisioned on Render for this to work —
// it falls back to secrets that are already configured for this module, so login sessions work
// immediately. Set SEAMLESS_SESSION_SECRET explicitly for a cleaner secret-separation story.
function readSessionSecret() {
  const { password } = readAppBasicCredentials();
  return String(
    process.env.SEAMLESS_SESSION_SECRET || readInternalApiToken() || password || "",
  ).trim();
}

function readSessionCookieMaxAgeMs() {
  const days = Number(process.env.SEAMLESS_SESSION_DAYS || 7);
  const safeDays = Number.isFinite(days) && days > 0 ? days : 7;
  return safeDays * 24 * 60 * 60 * 1000;
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
    shopeeBucket: String(process.env.SHOPEE_R2_BUCKET || "").trim(),
    keyPrefix: String(process.env.SEAMLESS_R2_KEY_PREFIX || "clasp-scx-seamless").trim(),
    forcePathStyle: ["1", "true", "yes", "on"].includes(
      String(process.env.SEAMLESS_R2_FORCE_PATH_STYLE || "").trim().toLowerCase(),
    ),
  };
}

function readStorageDir() {
  return String(process.env.SEAMLESS_STORAGE_DIR || "storage/seamless").trim();
}

// Falls back to Render's own auto-injected RENDER_EXTERNAL_URL (e.g.
// https://sc-official-website.onrender.com) so download/view URLs come out as absolute links
// without needing a new Render env var — required now that the client is a separate Static Site
// from this API: a relative "/api/files/:id/download" resolves against whatever origin the link
// is clicked from (the client's own site), not this API, so the client's own SPA fallback route
// silently served its homepage instead of the file.
function readPublicBaseUrl() {
  return String(process.env.SEAMLESS_PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").trim();
}

// Pinned rather than left to whoever configures the mailbox, since ingesting from the wrong
// mailbox would silently mix unrelated mail into PharmCare's financial-document pipeline.
function readPharmcareGmailConfig() {
  return {
    mailboxAccount: String(
      process.env.SEAMLESS_PHARMCARE_GMAIL_MAILBOX || "admin@scgroup1989.com",
    ).trim(),
    authMode: String(process.env.SEAMLESS_PHARMCARE_GMAIL_AUTH_MODE || "").trim(),
    serviceAccountJson: String(
      process.env.SEAMLESS_PHARMCARE_GMAIL_SERVICE_ACCOUNT_JSON || "",
    ).trim(),
    impersonatedUser: String(
      process.env.SEAMLESS_PHARMCARE_GMAIL_IMPERSONATED_USER ||
        process.env.SEAMLESS_PHARMCARE_GMAIL_MAILBOX ||
        "admin@scgroup1989.com",
    ).trim(),
    clientId: String(process.env.SEAMLESS_PHARMCARE_GMAIL_CLIENT_ID || "").trim(),
    clientSecret: String(process.env.SEAMLESS_PHARMCARE_GMAIL_CLIENT_SECRET || "").trim(),
    refreshToken: String(process.env.SEAMLESS_PHARMCARE_GMAIL_REFRESH_TOKEN || "").trim(),
    // Gmail search query for candidate messages. The default covers both delivery routes this
    // mailbox sees: direct/filter-forwarded mail from PharmCare itself, and the historical
    // manual forwards sent from the auukunn.bkk@gmail.com source mailbox (visible From is the
    // forwarder, not PharmCare).
    //
    // A bare `from:auukunn.bkk@gmail.com` is deliberately NOT used here: that mailbox forwards
    // plenty of unrelated mail (observed live: branch call-tracking/daily-summary reports from
    // an unrelated "CI Reports Bot"), and a query that broad pulls all of it into this pipeline
    // — the sender-allowlist check catches it at classification time (manual_review), but by
    // then it has already burned Gmail API quota and cluttered the inbox. Requiring the literal
    // string "info@pharmcare.co" to also appear in the message text (present in every genuine
    // forwarded block's "From:" line) keeps the query itself scoped to real PharmCare forwards.
    // Override with SEAMLESS_PHARMCARE_GMAIL_QUERY if the routes change.
    gmailQuery: String(
      process.env.SEAMLESS_PHARMCARE_GMAIL_QUERY ||
        '(from:info@pharmcare.co) OR (from:auukunn.bkk@gmail.com "info@pharmcare.co")',
    ).trim(),
    // Google Cloud Pub/Sub topic that Gmail publishes mailbox-change notifications to, and the
    // shared secret this backend checks on the push-webhook URL (Google can't do Basic Auth, so
    // the secret is a query-string token instead — see docs/14 M2 real-time sync design).
    pubsubTopicName: String(process.env.SEAMLESS_PHARMCARE_GMAIL_PUBSUB_TOPIC || "").trim(),
    webhookSecret: String(process.env.SEAMLESS_PHARMCARE_GMAIL_WEBHOOK_SECRET || "").trim(),
  };
}

// Shopee email reporting reads the same admin mailbox through the already-provisioned,
// read-only Gmail OAuth credential. Only the search scope differs from PharmCare. Keeping the
// credential source shared avoids a second refresh token for the same mailbox, while the pinned
// default query prevents this app-facing endpoint from becoming a general mailbox browser.
function readShopeeGmailConfig() {
  const sharedMailboxConfig = readPharmcareGmailConfig();

  return {
    ...sharedMailboxConfig,
    gmailQuery: String(
      process.env.SEAMLESS_SHOPEE_GMAIL_QUERY || "from:info@mail.shopee.co.th",
    ).trim(),
  };
}

const SHOPEE_DRMOREPEN_MAILBOX = "scgroup1989.glucooneshop@gmail.com";
const SHOPEE_DRMOREPEN_QUERY = "from:info@mail.shopee.co.th";

function requirePinnedConfigValue(name, value, expected) {
  const configured = String(value || expected).trim();
  if (configured !== expected) {
    const error = new Error(`${name} must remain pinned to its approved value.`);
    error.statusCode = 500;
    throw error;
  }
  return configured;
}

// DR.Morepen has its own Gmail account and refresh token. Nothing in this reader falls back to
// SEAMLESS_PHARMCARE_GMAIL_*: a partially configured deployment must fail closed instead of
// silently reading the admin mailbox. The mailbox and sender query are pinned because they are
// security boundaries, while the OAuth Desktop client itself may be reused across accounts.
function readShopeeDrMorepenGmailConfig() {
  const envPrefix = "SEAMLESS_SHOPEE_DRMOREPEN_GMAIL";
  const authMode = String(process.env[`${envPrefix}_AUTH_MODE`] || "").trim();
  if (authMode && authMode !== "oauth_refresh_token") {
    const error = new Error(`${envPrefix}_AUTH_MODE must be oauth_refresh_token.`);
    error.statusCode = 500;
    throw error;
  }

  return {
    authMode,
    clientId: String(process.env[`${envPrefix}_CLIENT_ID`] || "").trim(),
    clientSecret: String(process.env[`${envPrefix}_CLIENT_SECRET`] || "").trim(),
    credentialEnvPrefix: envPrefix,
    expectedMailbox: SHOPEE_DRMOREPEN_MAILBOX,
    gmailQuery: requirePinnedConfigValue(
      `${envPrefix}_QUERY`,
      process.env[`${envPrefix}_QUERY`],
      SHOPEE_DRMOREPEN_QUERY,
    ),
    mailboxAccount: requirePinnedConfigValue(
      `${envPrefix}_MAILBOX`,
      process.env[`${envPrefix}_MAILBOX`],
      SHOPEE_DRMOREPEN_MAILBOX,
    ),
    refreshToken: String(process.env[`${envPrefix}_REFRESH_TOKEN`] || "").trim(),
    shopCode: "dr-morepen",
  };
}

// Existing callers that do not select a shop retain the original admin-mailbox Shopee config.
// Explicit shop routing is additive and derives shopCode from the mailbox mapping, never from
// an email subject or body.
function readShopeeGmailConfigForShop(shopCode) {
  const normalized = String(shopCode || "").trim().toLowerCase();
  if (!normalized) return readShopeeGmailConfig();
  if (normalized === "dr-morepen") return readShopeeDrMorepenGmailConfig();
  if (normalized === "sc-drug-store") {
    return { ...readShopeeGmailConfig(), shopCode: "sc-drug-store" };
  }

  const error = new Error(`Unsupported Shopee Gmail shop code: ${shopCode}`);
  error.statusCode = 400;
  throw error;
}

function readPharmcareSenderAllowlist() {
  const raw = String(process.env.SEAMLESS_PHARMCARE_SENDER_ALLOWLIST || "").trim();
  if (!raw) {
    return null; // caller falls back to the classifier's own default allowlist
  }

  return raw
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function readEmailConfig() {
  return {
    provider: String(process.env.EMAIL_PROVIDER || "sendgrid").trim().toLowerCase(),
    brevoApiKey: String(process.env.BREVO_API_KEY || "").trim(),
    sendgridApiKey: String(process.env.SENDGRID_API_KEY || "").trim(),
    mailFrom: String(process.env.MAIL_FROM || process.env.MAIL_USER || process.env.SEAMLESS_MAIL_FROM || "").trim(),
    docsRecipientEmail: String(
      process.env.DOCS_RECIPIENT_EMAIL || process.env.SEAMLESS_DOCS_RECIPIENT_EMAIL || "",
    ).trim(),
  };
}

module.exports = {
  readAppAdminBasicCredentials,
  readAppBasicCredentials,
  readAutoPrintSince,
  readEmailConfig,
  readInternalApiToken,
  readLineConfig,
  readPharmcareGmailConfig,
  readPharmcareSenderAllowlist,
  readPublicBaseUrl,
  readR2Config,
  readSchemaName,
  readSessionCookieMaxAgeMs,
  readSessionSecret,
  readShopeeDrMorepenGmailConfig,
  readShopeeGmailConfig,
  readShopeeGmailConfigForShop,
  readStorageDir,
};
