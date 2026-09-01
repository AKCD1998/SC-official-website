const {
  createShopeeGmailPushSyncScheduler,
} = require("../src/modules/seamless/services/shopeeGmailPushSyncScheduler");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test("coalesces notifications for one shop into one pending rerun", async () => {
  const first = deferred();
  const runSync = jest.fn()
    .mockImplementationOnce(() => first.promise)
    .mockResolvedValueOnce({ pages: 1, stopReason: "known_history_reached" });
  const scheduler = createShopeeGmailPushSyncScheduler({
    log: jest.fn(),
    runSync,
    syncPage: jest.fn(),
  });

  const firstSchedule = scheduler.schedule({ historyId: "1", messageId: "m1", shopCode: "sc-drug-store" });
  const secondSchedule = scheduler.schedule({ historyId: "2", messageId: "m2", shopCode: "sc-drug-store" });

  expect(firstSchedule).toBe(secondSchedule);
  expect(runSync).toHaveBeenCalledTimes(1);
  first.resolve({ pages: 1, stopReason: "known_history_reached" });
  await firstSchedule;

  expect(runSync).toHaveBeenCalledTimes(2);
  expect(scheduler.isRunning("sc-drug-store")).toBe(false);
});

test("allows the two pinned shops to sync independently", async () => {
  const runs = [];
  const runSync = jest.fn(async ({ shopCode }) => {
    runs.push(shopCode);
    return { pages: 1, stopReason: "known_history_reached" };
  });
  const scheduler = createShopeeGmailPushSyncScheduler({
    log: jest.fn(),
    runSync,
    syncPage: jest.fn(),
  });

  await Promise.all([
    scheduler.schedule({ historyId: "1", messageId: "m1", shopCode: "sc-drug-store" }),
    scheduler.schedule({ historyId: "2", messageId: "m2", shopCode: "dr-morepen" }),
  ]);

  expect(runs.sort()).toEqual(["dr-morepen", "sc-drug-store"]);
});

test("cleans up a failed run so a later notification can retry", async () => {
  const runSync = jest.fn()
    .mockRejectedValueOnce(new Error("temporary failure"))
    .mockResolvedValueOnce({ pages: 1, stopReason: "known_history_reached" });
  const scheduler = createShopeeGmailPushSyncScheduler({
    log: jest.fn(),
    runSync,
    syncPage: jest.fn(),
  });

  await expect(scheduler.schedule({ historyId: "1", messageId: "m1", shopCode: "sc-drug-store" }))
    .rejects.toThrow("temporary failure");
  expect(scheduler.isRunning("sc-drug-store")).toBe(false);

  await expect(scheduler.schedule({ historyId: "2", messageId: "m2", shopCode: "sc-drug-store" }))
    .resolves.toMatchObject({ pages: 1 });
  expect(runSync).toHaveBeenCalledTimes(2);
});
