const {
  CONSERVATIVE_UNITS_PER_PAGE,
  PAGE_INTERVAL_MS,
  runScheduledShopeeSync,
} = require("../scripts/shopee-order-sync.cjs");

test("scheduled sync CLI resolves the production database module", () => {
  expect(() => require.resolve("../db")).not.toThrow();
});

function page(overrides = {}) {
  return {
    deduplicatedEvents: 0,
    nextCursor: null,
    processedMessages: 25,
    skippedMessages: 0,
    storedEvents: 25,
    ...overrides,
  };
}

test("scheduled sync stops after processing the first page that reaches known history", async () => {
  const syncPage = jest.fn(async () => page({
    deduplicatedEvents: 23,
    nextCursor: "older",
    skippedMessages: 1,
    storedEvents: 1,
  }));
  const log = jest.fn();
  const sleep = jest.fn();

  const result = await runScheduledShopeeSync({ log, syncPage, sleep });

  expect(syncPage).toHaveBeenCalledWith({ cursor: undefined, limit: 25 });
  expect(syncPage).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    conservativeQuotaUnits: CONSERVATIVE_UNITS_PER_PAGE,
    deduplicatedEvents: 23,
    pages: 1,
    stopReason: "known_history_reached",
    storedEvents: 1,
  });
});

test("scheduled sync follows a burst across pages at the quota-safe interval", async () => {
  const syncPage = jest
    .fn()
    .mockResolvedValueOnce(page({ nextCursor: "page-2" }))
    .mockResolvedValueOnce(page({ nextCursor: "page-3", skippedMessages: 2, storedEvents: 23 }))
    .mockResolvedValueOnce(page({ deduplicatedEvents: 20, nextCursor: "older", storedEvents: 5 }));
  const sleep = jest.fn(async () => {});
  const log = jest.fn();

  const result = await runScheduledShopeeSync({ log, syncPage, sleep });

  expect(syncPage.mock.calls).toEqual([
    [{ cursor: undefined, limit: 25 }],
    [{ cursor: "page-2", limit: 25 }],
    [{ cursor: "page-3", limit: 25 }],
  ]);
  expect(sleep.mock.calls).toEqual([[PAGE_INTERVAL_MS], [PAGE_INTERVAL_MS]]);
  expect(result).toMatchObject({
    conservativeQuotaUnits: CONSERVATIVE_UNITS_PER_PAGE * 3,
    pages: 3,
    processedMessages: 75,
    stopReason: "known_history_reached",
    storedEvents: 53,
  });
});

test("scheduled sync stops when Gmail has no older page", async () => {
  const result = await runScheduledShopeeSync({
    log: jest.fn(),
    sleep: jest.fn(),
    syncPage: jest.fn(async () => page({ processedMessages: 3, skippedMessages: 3, storedEvents: 0 })),
  });

  expect(result).toMatchObject({
    pages: 1,
    processedMessages: 3,
    stopReason: "mailbox_exhausted",
  });
});

test("scheduled sync fails closed when the burst exceeds the per-run page cap", async () => {
  const syncPage = jest.fn(async ({ cursor }) => page({ nextCursor: `${cursor || "page"}-next` }));
  const sleep = jest.fn(async () => {});

  await expect(runScheduledShopeeSync({ log: jest.fn(), maxPages: 2, sleep, syncPage }))
    .rejects.toThrow("safety cap reached");

  expect(syncPage).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledTimes(1);
});

test("scheduled sync never retries a Gmail or database failure", async () => {
  const quotaError = new Error("quota");
  quotaError.response = { status: 429 };
  const syncPage = jest.fn(async () => { throw quotaError; });

  await expect(runScheduledShopeeSync({ syncPage })).rejects.toBe(quotaError);
  expect(syncPage).toHaveBeenCalledTimes(1);
});

test("scheduled sync refuses a page interval that would violate its quota budget", async () => {
  await expect(runScheduledShopeeSync({
    intervalMs: PAGE_INTERVAL_MS - 1,
    syncPage: jest.fn(),
  })).rejects.toThrow(`intervalMs must be at least ${PAGE_INTERVAL_MS}`);
});
