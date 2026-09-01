const PAGE_SIZE = 25;
const PAGE_INTERVAL_MS = 20_000;
const MAX_PAGES_PER_RUN = 10;
const CONSERVATIVE_UNITS_PER_PAGE = 5 + (PAGE_SIZE * 20);

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function defaultLog(payload) {
  console.log(JSON.stringify(payload));
}

function count(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

async function runScheduledShopeeSync({
  intervalMs = PAGE_INTERVAL_MS,
  log = defaultLog,
  maxPages = MAX_PAGES_PER_RUN,
  shopCode,
  sleep = defaultSleep,
  syncPage,
} = {}) {
  if (typeof syncPage !== "function") {
    throw new TypeError("syncPage is required.");
  }
  if (!String(shopCode || "").trim()) {
    throw new TypeError("shopCode is required.");
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES_PER_RUN) {
    throw new RangeError(`maxPages must be between 1 and ${MAX_PAGES_PER_RUN}.`);
  }
  if (!Number.isInteger(intervalMs) || intervalMs < PAGE_INTERVAL_MS) {
    throw new RangeError(`intervalMs must be at least ${PAGE_INTERVAL_MS}.`);
  }

  let cursor;
  const totals = {
    conservativeQuotaUnits: 0,
    deduplicatedEvents: 0,
    pages: 0,
    processedMessages: 0,
    skippedMessages: 0,
    storedEvents: 0,
  };

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await syncPage({ cursor, limit: PAGE_SIZE, shopCode });
    const hasNextPage = Boolean(result?.nextCursor);
    const deduplicatedEvents = count(result?.deduplicatedEvents);
    const processedMessages = count(result?.processedMessages);
    const skippedMessages = count(result?.skippedMessages);
    const storedEvents = count(result?.storedEvents);

    totals.pages += 1;
    totals.processedMessages += processedMessages;
    totals.storedEvents += storedEvents;
    totals.deduplicatedEvents += deduplicatedEvents;
    totals.skippedMessages += skippedMessages;
    // This deliberately over-counts a short final page so the quota report fails safe.
    totals.conservativeQuotaUnits += CONSERVATIVE_UNITS_PER_PAGE;

    log({
      conservativeQuotaUnits: totals.conservativeQuotaUnits,
      deduplicatedEvents,
      hasNextPage,
      page: pageNumber,
      processedMessages,
      shopCode,
      skippedMessages,
      storedEvents,
      type: "shopee_sync_page",
    });

    // Gmail returns newest messages first. Once a page contains an event already in PostgreSQL,
    // the entire page has been processed and the runner has reached known history.
    if (deduplicatedEvents > 0) {
      return { ...totals, stopReason: "known_history_reached" };
    }
    if (!hasNextPage) {
      return { ...totals, stopReason: "mailbox_exhausted" };
    }
    if (pageNumber === maxPages) {
      throw new Error("Shopee sync safety cap reached before known history; backlog remains.");
    }

    cursor = result.nextCursor;
    // Four worst-case pages cost 2,020 units in any 60-second window, leaving more than 66%
    // headroom against the 6,000-unit per-user/per-project Gmail quota.
    // eslint-disable-next-line no-await-in-loop
    await sleep(intervalMs);
  }

  throw new Error("Shopee sync ended unexpectedly.");
}

module.exports = {
  CONSERVATIVE_UNITS_PER_PAGE,
  MAX_PAGES_PER_RUN,
  PAGE_INTERVAL_MS,
  PAGE_SIZE,
  runScheduledShopeeSync,
};
