const crypto = require("node:crypto");
const { createGmailAdapter, isGmailConfigured } = require("../services/pharmcare/gmailAdapter");
const { runPharmcareGmailSync } = require("../services/pharmcareSyncService");
const { sendTextAlert } = require("../services/lineNotifyService");
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
  // slow or errors, and a retry landing here again is harmless — runPharmcareGmailSync's
  // advisory lock makes a concurrent sync a no-op 'lock_busy' run, never a duplicate ingest.
  res.status(204).end();

  if (!isGmailConfigured(config)) {
    return;
  }

  try {
    const adapter = createGmailAdapter(config);
    const outcome = await runPharmcareGmailSync(adapter, config.mailboxAccount, { runKind: "incremental" });

    // There is no periodic health check on this (see docs/18) — the only alert path today is
    // "a real sync attempt happened and it had errors". A dead/expired watch() subscription
    // produces no webhook calls at all and so cannot be caught here; that gap is accepted for
    // now and documented, with a paid Render Cron Job fallback planned once usage grows.
    if (outcome.status === "failed") {
      const failedCount = outcome.results.filter((r) => r.status === "failed").length;
      await sendTextAlert(
        `⚠️ PharmCare Gmail sync (webhook-triggered) completed with ${failedCount} failed message(s). Check pharmcare_sync_runs (runId: ${outcome.runId}) or run: node scripts/pharmcare-gmail.cjs status`,
      ).catch((alertError) => {
        console.error("[pharmcare-gmail-webhook] LINE alert failed:", alertError.message);
      });
    }
  } catch (error) {
    // Response is already sent — nothing left to do but log + alert. The next webhook call or a
    // manual sync will pick up anything missed here.
    console.error("[pharmcare-gmail-webhook] incremental sync failed:", error.message);
    await sendTextAlert(`⚠️ PharmCare Gmail sync (webhook-triggered) crashed: ${error.message}`).catch(
      (alertError) => {
        console.error("[pharmcare-gmail-webhook] LINE alert failed:", alertError.message);
      },
    );
  }
}

module.exports = { handleGmailWebhook };
