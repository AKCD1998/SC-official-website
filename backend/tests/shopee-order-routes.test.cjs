const express = require("express");
const request = require("supertest");

const orderRow = {
  currentStatus: "shipment_due",
  eventCount: 2,
  firstEventAt: "2026-08-24T02:00:00.000Z",
  itemCount: 1,
  items: [{ name: "สินค้าทดสอบ", quantity: 1, unitPrice: 70, variant: "1 ขวด" }],
  lastEventAt: "2026-08-24T03:00:00.000Z",
  orderNumber: "26082471YK8C02",
  shippingDeadline: "2026-08-30",
  totalAmount: 108,
  totalQuantity: 1,
};

const listOrdersMock = jest.fn(async () => ({ hasMore: true, orders: [orderRow] }));
const getOrderTimelineMock = jest.fn(async () => ({
  events: [{ details: {}, eventType: "shipment_due", id: "event-1", occurredAt: orderRow.lastEventAt }],
  order: orderRow,
}));
const syncShopeeOrderPageMock = jest.fn(async () => ({
  deduplicatedEvents: 0,
  nextCursor: "gmail-next",
  processedMessages: 2,
  skippedMessages: 1,
  source: "info@mail.shopee.co.th",
  storedEvents: 1,
}));
const getShopeeAccountingCycleStatusMock = jest.fn(async () => ({
  basis: "continuous_four_week_cycle",
  hasHistory: true,
  lastCompletedCycle: { periodStart: "2026-06-29", periodEnd: "2026-07-26" },
  nextCycle: {
    periodStart: "2026-07-27",
    periodEnd: "2026-08-23",
    weeks: [
      { name: "27.07-02.08", start: "2026-07-27", end: "2026-08-02" },
      { name: "03-09.08", start: "2026-08-03", end: "2026-08-09" },
      { name: "10-16.08", start: "2026-08-10", end: "2026-08-16" },
      { name: "17-23.08", start: "2026-08-17", end: "2026-08-23" },
    ],
  },
  timezone: "Asia/Bangkok",
}));

jest.mock("../src/modules/seamless/db/shopeeOrderRepository", () => ({
  getOrderTimeline: (...args) => getOrderTimelineMock(...args),
  listOrders: (...args) => listOrdersMock(...args),
}));

jest.mock("../src/modules/seamless/services/shopeeOrderTimelineService", () => ({
  syncShopeeOrderPage: (...args) => syncShopeeOrderPageMock(...args),
}));

jest.mock("../src/modules/seamless/services/shopeeAccountingCycleStatusService", () => ({
  getShopeeAccountingCycleStatus: (...args) => getShopeeAccountingCycleStatusMock(...args),
}));

const { errorHandler } = require("../src/modules/seamless/middleware/errorHandler");

function buildApp() {
  delete require.cache[require.resolve("../src/modules/seamless/middleware/appAuth")];
  delete require.cache[require.resolve("../src/modules/seamless/routes/shopeeEmailRoutes")];
  // eslint-disable-next-line global-require
  const routes = require("../src/modules/seamless/routes/shopeeEmailRoutes");
  const app = express();
  app.use(express.json());
  app.use("/api/app/shopee", routes);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SEAMLESS_APP_BASIC_USER;
  delete process.env.SEAMLESS_APP_BASIC_PASSWORD;
  delete process.env.SEAMLESS_APP_ADMIN_BASIC_USER;
  delete process.env.SEAMLESS_APP_ADMIN_BASIC_PASSWORD;
});

test("lists persisted Shopee orders with an opaque cursor", async () => {
  const response = await request(buildApp()).get("/api/app/shopee/orders?status=shipment_due&limit=10");

  expect(response.status).toBe(200);
  expect(response.body.orders).toEqual([orderRow]);
  expect(response.body.nextCursor).toEqual(expect.any(String));
  expect(listOrdersMock).toHaveBeenCalledWith({ cursor: null, limit: 10, status: "shipment_due" });
});

test("returns the latest completed and next four-week accounting cycles", async () => {
  const response = await request(buildApp()).get("/api/app/shopee/accounting-cycle");

  expect(response.status).toBe(200);
  expect(response.body.lastCompletedCycle.periodEnd).toBe("2026-07-26");
  expect(response.body.nextCycle.periodStart).toBe("2026-07-27");
  expect(response.body.nextCycle.periodEnd).toBe("2026-08-23");
  expect(response.body.nextCycle.weeks).toHaveLength(4);
  expect(getShopeeAccountingCycleStatusMock).toHaveBeenCalledTimes(1);
});

test("returns one order and its chronological event timeline", async () => {
  const response = await request(buildApp()).get("/api/app/shopee/orders/26082471YK8C02");

  expect(response.status).toBe(200);
  expect(response.body.order.orderNumber).toBe("26082471YK8C02");
  expect(response.body.events[0].eventType).toBe("shipment_due");
  expect(getOrderTimelineMock).toHaveBeenCalledWith("26082471YK8C02");
});

test("allows only an admin session to sync full Gmail bodies into the timeline", async () => {
  process.env.SEAMLESS_APP_BASIC_USER = "staff001";
  process.env.SEAMLESS_APP_BASIC_PASSWORD = "staff-password";
  process.env.SEAMLESS_APP_ADMIN_BASIC_USER = "admin001";
  process.env.SEAMLESS_APP_ADMIN_BASIC_PASSWORD = "admin-password";

  const regular = await request(buildApp())
    .post("/api/app/shopee/orders/sync")
    .auth("staff001", "staff-password")
    .send({ limit: 10 });
  expect(regular.status).toBe(403);
  expect(syncShopeeOrderPageMock).not.toHaveBeenCalled();

  const admin = await request(buildApp())
    .post("/api/app/shopee/orders/sync")
    .auth("admin001", "admin-password")
    .send({ cursor: "gmail-page", limit: 10 });
  expect(admin.status).toBe(200);
  expect(syncShopeeOrderPageMock).toHaveBeenCalledWith({ cursor: "gmail-page", limit: 10 });
});

test("returns a non-blocking conflict when the mailbox sync lock is busy", async () => {
  process.env.SEAMLESS_APP_ADMIN_BASIC_USER = "admin001";
  process.env.SEAMLESS_APP_ADMIN_BASIC_PASSWORD = "admin-password";
  const busy = new Error("A Shopee order timeline sync is already running for this mailbox.");
  busy.statusCode = 409;
  busy.code = "CONFLICT";
  syncShopeeOrderPageMock.mockRejectedValueOnce(busy);

  const response = await request(buildApp())
    .post("/api/app/shopee/orders/sync")
    .auth("admin001", "admin-password")
    .send({ limit: 25 });

  expect(response.status).toBe(409);
  expect(response.body.error.message).toContain("already running");
});

test.each([
  ["/api/app/shopee/orders?status=unknown", "status"],
  ["/api/app/shopee/orders?limit=26", "limit"],
  ["/api/app/shopee/orders?cursor=broken", "cursor"],
  ["/api/app/shopee/orders/SHORT", "orderNumber"],
  ["/api/app/shopee/orders/not-valid!", "orderNumber"],
])("rejects invalid timeline request %s", async (path, messagePart) => {
  const response = await request(buildApp()).get(path);
  expect(response.status).toBe(400);
  expect(response.body.error.message).toContain(messagePart);
});
