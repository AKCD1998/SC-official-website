const crypto = require("node:crypto");
const { isGmailConfigured } = require("../services/pharmcare/gmailAdapter");
const { schedulePharmcareGmailPushSync } = require("../services/pharmcareGmailPushSyncScheduler");
const { readPharmcareGmailConfig } = require("../config");
const { unauthorized } = require("../errors");

function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Gmail's Pub/Sub push subscription calls this with no Basic/Bearer credential of ours (same
// situation as the LINE webhook) — protected instead by a shared secret token on the URL, since
// Pub/Sub push subscriptions don't support HMAC body signing the way LINE does. The notification
// body itself (a base64-encoded {emailAddress, historyId} envelope) is deliberately NOT parsed
// here: it never carries message content, only "something changed" — so the actual work is just
// re-running the same scoped incremental sync (SEAMLESS_PHARMCARE_GMAIL_QUERY + stored
// checkpoint) already used for manual/cron syncs, which is idempotent and safe to over-trigger.
async function handleGmailWebhook(req, res) {
  const config = readPharmcareGmailConfig();

  if (!config.webhookSecret || !timingSafeEqualStrings(req.query.token, config.webhookSecret)) {
    throw unauthorized("Invalid or missing webhook token.");
  }

  // Acknowledge Pub/Sub immediately. Push subscriptions retry (with backoff) if the endpoint is
  // slow or errors. The scheduler coalesces duplicates before requesting a DB connection;
  // the sync's advisory lock also protects against other processes and manual runs.
  res.status(204).end();

  if (!isGmailConfigured(config)) {
    return;
  }

  try {
    await schedulePharmcareGmailPushSync(config);
  } catch (error) {
    // The scheduler logs sync failures once per run, not once per waiting webhook.
    // This path catches an unexpected scheduler error after the response was sent.
    console.error("[pharmcare-gmail-webhook] incremental sync failed:", error.message);
  }
}

module.exports = { handleGmailWebhook };
