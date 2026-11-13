jest.mock("../src/modules/seamless/services/pharmcare/gmailAdapter", () => ({ createGmailAdapter: jest.fn() }));
jest.mock("../src/modules/seamless/services/pharmcareSyncService", () => ({ runPharmcareGmailSync: jest.fn() }));
jest.mock("../src/modules/seamless/services/lineNotifyService", () => ({ sendTextAlert: jest.fn() }));

const {
  ALERT_INTERVAL_MS, FAILURE_BACKOFF_MS, MIN_RUN_INTERVAL_MS,
  createPharmcareGmailPushSyncScheduler,
} = require("../src/modules/seamless/services/pharmcareGmailPushSyncScheduler");
const config = { mailboxAccount: "admin@example.test" };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(overrides = {}) {
  let time = 0;
  const runSync = jest.fn(async () => ({ status: "completed" }));
  const sleep = jest.fn(async (ms) => { time += ms; });
  const log = jest.fn();
  const sendAlert = jest.fn(async () => ({ skipped: false }));
  return {
    runSync, sleep, log, sendAlert,
    advance: (ms) => { time += ms; },
    scheduler: createPharmcareGmailPushSyncScheduler({
      runSync, sleep, log, sendAlert, now: () => time, createAdapter: () => ({}), ...overrides,
    }),
  };
}

afterEach(() => { delete process.env.SEAMLESS_PHARMCARE_GMAIL_LINE_ALERTS_ENABLED; });

test("a push burst uses one worker and preserves one rescan for arrivals during work", async () => {
  const task = setup();
  let finish;
  task.runSync.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const first = task.scheduler.schedule(config);
  await tick();
  const duplicates = Array.from({ length: 50 }, () => task.scheduler.schedule(config));
  expect(duplicates.every((promise) => promise === first)).toBe(true);
  expect(task.runSync).toHaveBeenCalledTimes(1);
  finish({ status: "completed" });
  await Promise.all([first, ...duplicates]);
  expect(task.runSync).toHaveBeenCalledTimes(2);
  expect(task.sleep).toHaveBeenCalledWith(MIN_RUN_INTERVAL_MS);
  expect(task.runSync).toHaveBeenCalledWith({}, config.mailboxAccount, { runKind: "incremental" });
});

test("an error is logged once for all waiting pushes and the rescan backs off", async () => {
  const task = setup();
  let fail;
  task.runSync.mockImplementationOnce(() => new Promise((resolve, reject) => { fail = reject; }));
  const first = task.scheduler.schedule(config);
  await tick();
  for (let index = 0; index < 20; index += 1) task.scheduler.schedule(config);
  fail(Object.assign(new Error("statement timeout"), { code: "57014" }));
  await first;
  expect(task.log).toHaveBeenCalledTimes(1);
  expect(task.sleep).toHaveBeenCalledWith(FAILURE_BACKOFF_MS);
  expect(task.runSync).toHaveBeenCalledTimes(2);
  expect(task.sendAlert).not.toHaveBeenCalled();
});

test("the failure backoff also applies to a later, separate push", async () => {
  const task = setup();
  task.runSync.mockRejectedValueOnce(new Error("connection capacity"));
  await task.scheduler.schedule(config);
  await task.scheduler.schedule(config);
  expect(task.sleep).toHaveBeenCalledWith(FAILURE_BACKOFF_MS);
  expect(task.runSync).toHaveBeenCalledTimes(2);
});

test("LINE stays muted by default; opt-in sends at most one alert per 30 minutes", async () => {
  const task = setup();
  task.runSync.mockResolvedValue({ status: "failed", runId: "run-1" });
  await task.scheduler.schedule(config);
  expect(task.sendAlert).not.toHaveBeenCalled();
  process.env.SEAMLESS_PHARMCARE_GMAIL_LINE_ALERTS_ENABLED = "true";
  await task.scheduler.schedule(config);
  await task.scheduler.schedule(config);
  expect(task.sendAlert).toHaveBeenCalledTimes(1);
  task.advance(ALERT_INTERVAL_MS);
  await task.scheduler.schedule(config);
  expect(task.sendAlert).toHaveBeenCalledTimes(2);
});

test("a failed LINE request does not retry the sync or flood more alert attempts", async () => {
  const task = setup({ alertsEnabled: () => true });
  task.sendAlert.mockRejectedValue(new Error("LINE unavailable"));
  task.runSync.mockResolvedValue({ status: "failed" });
  await task.scheduler.schedule(config);
  await task.scheduler.schedule(config);
  expect(task.runSync).toHaveBeenCalledTimes(2);
  expect(task.sendAlert).toHaveBeenCalledTimes(1);
  expect(task.log).toHaveBeenCalledWith(expect.objectContaining({ type: "pharmcare_gmail_line_alert_failed" }));
});

test("a stalled LINE request cannot hold up the next Gmail sync", async () => {
  const task = setup({ alertsEnabled: () => true });
  task.sendAlert.mockImplementation(() => new Promise(() => {}));
  task.runSync.mockResolvedValueOnce({ status: "failed" });
  await task.scheduler.schedule(config);
  await task.scheduler.schedule(config);
  expect(task.runSync).toHaveBeenCalledTimes(2);
  expect(task.sendAlert).toHaveBeenCalledTimes(1);
});
