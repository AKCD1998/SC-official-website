const { syncShopeeOrderPage } = require("./shopeeOrderTimelineService");
const { runScheduledShopeeSync } = require("./shopeeOrderSyncRunner");
const { requireShopeeShopCode } = require("./shopeeShops");

function defaultLog(level, payload) {
  const writer = level === "error" ? console.error : console.log;
  writer(JSON.stringify(payload));
}

// Pub/Sub can deliver duplicates or several notifications while a sync is already running.
// Keep at most one runner per shop in this process and remember one pending rerun. PostgreSQL's
// existing per-shop advisory lock remains the cross-process safety boundary.
function createShopeeGmailPushSyncScheduler(dependencies = {}) {
  const activeRuns = new Map();
  const log = dependencies.log || defaultLog;
  const runSync = dependencies.runSync || runScheduledShopeeSync;
  const syncPage = dependencies.syncPage || syncShopeeOrderPage;

  function schedule({ historyId, messageId, shopCode }) {
    const normalizedShopCode = requireShopeeShopCode(shopCode);
    const current = activeRuns.get(normalizedShopCode);
    if (current) {
      current.pending = true;
      log("info", {
        historyId,
        messageId,
        shopCode: normalizedShopCode,
        type: "shopee_gmail_push_coalesced",
      });
      return current.promise;
    }

    const state = { pending: true, promise: null };
    state.promise = (async () => {
      let lastError = null;
      let lastResult = null;

      do {
        state.pending = false;
        try {
          // eslint-disable-next-line no-await-in-loop
          lastResult = await runSync({ shopCode: normalizedShopCode, syncPage });
          lastError = null;
          log("info", {
            ...lastResult,
            historyId,
            messageId,
            shopCode: normalizedShopCode,
            type: "shopee_gmail_push_sync_complete",
          });
        } catch (error) {
          lastError = error;
          log("error", {
            httpStatus: error?.response?.status || error?.statusCode || null,
            name: error?.name || "Error",
            shopCode: normalizedShopCode,
            type: "shopee_gmail_push_sync_failed",
          });
        }
      } while (state.pending);

      if (lastError) throw lastError;
      return lastResult;
    })().finally(() => {
      if (activeRuns.get(normalizedShopCode) === state) {
        activeRuns.delete(normalizedShopCode);
      }
    });

    activeRuns.set(normalizedShopCode, state);
    return state.promise;
  }

  return {
    isRunning(shopCode) {
      return activeRuns.has(requireShopeeShopCode(shopCode));
    },
    schedule,
  };
}

const defaultScheduler = createShopeeGmailPushSyncScheduler();

module.exports = {
  createShopeeGmailPushSyncScheduler,
  scheduleShopeeGmailPushSync: defaultScheduler.schedule,
};
