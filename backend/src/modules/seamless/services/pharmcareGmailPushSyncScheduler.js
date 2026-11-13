const { createGmailAdapter } = require("./pharmcare/gmailAdapter");
const { runPharmcareGmailSync } = require("./pharmcareSyncService");
const { sendTextAlert } = require("./lineNotifyService");

const MIN_RUN_INTERVAL_MS = 5_000;
const FAILURE_BACKOFF_MS = 60_000;
const ALERT_INTERVAL_MS = 30 * 60_000;

// Only one worker and one pending rescan per process. The database advisory lock
// still protects manual syncs and other instances. In particular, duplicate push
// deliveries must not each acquire a connection just to record a lock_busy row.
function createPharmcareGmailPushSyncScheduler(dependencies = {}) {
  const runSync = dependencies.runSync || runPharmcareGmailSync;
  const createAdapter = dependencies.createAdapter || createGmailAdapter;
  const sendAlert = dependencies.sendAlert || sendTextAlert;
  const now = dependencies.now || Date.now;
  const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = dependencies.log || ((payload) => console.error(JSON.stringify(payload)));
  const alertsEnabled = dependencies.alertsEnabled || (() =>
    process.env.SEAMLESS_PHARMCARE_GMAIL_LINE_ALERTS_ENABLED === "true");
  let activeRun = null;
  let nextRunAt = 0;
  let nextAlertAt = 0;

  function reportFailure(outcome, error) {
    log({
      type: "pharmcare_gmail_push_sync_failed",
      runId: outcome?.runId || null,
      code: error?.code || null,
      message: error?.message || "Sync completed with failed messages.",
    });
    if (!alertsEnabled() || now() < nextAlertAt) return;
    // Reserve before awaiting LINE, including a failed send, to prevent an alert storm.
    nextAlertAt = now() + ALERT_INTERVAL_MS;
    // A slow LINE service must never hold up Gmail sync or its pending rescan.
    void Promise.resolve().then(() => sendAlert(
        `⚠️ PharmCare Gmail sync ขัดข้อง กรุณาตรวจ server log${outcome?.runId ? ` (runId: ${outcome.runId})` : ""}. แจ้งเตือนซ้ำอย่างเร็วทุก 30 นาที`,
      )).catch((alertError) => {
      log({ type: "pharmcare_gmail_line_alert_failed", message: alertError.message });
    });
  }

  function schedule(config) {
    if (activeRun) {
      activeRun.pending = true;
      return activeRun.promise;
    }

    const state = { pending: true, promise: null };
    activeRun = state;
    state.promise = Promise.resolve().then(async () => {
      let outcome;
      do {
        const delay = Math.max(0, nextRunAt - now());
        if (delay) await sleep(delay);
        // Calls arriving during the delay are covered by the rescan about to start.
        state.pending = false;
        try {
          outcome = await runSync(createAdapter(config), config.mailboxAccount, { runKind: "incremental" });
          nextRunAt = now() + (outcome.status === "failed" ? FAILURE_BACKOFF_MS : MIN_RUN_INTERVAL_MS);
          if (outcome.status === "failed") reportFailure(outcome);
        } catch (error) {
          outcome = { status: "failed" };
          nextRunAt = now() + FAILURE_BACKOFF_MS;
          reportFailure(null, error);
        }
      } while (state.pending);
      return outcome;
    }).finally(() => {
      if (activeRun === state) activeRun = null;
    });
    return state.promise;
  }

  return { schedule };
}

const defaultScheduler = createPharmcareGmailPushSyncScheduler();

module.exports = {
  ALERT_INTERVAL_MS,
  FAILURE_BACKOFF_MS,
  MIN_RUN_INTERVAL_MS,
  createPharmcareGmailPushSyncScheduler,
  schedulePharmcareGmailPushSync: defaultScheduler.schedule,
};
