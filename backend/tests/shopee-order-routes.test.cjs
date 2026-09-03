const express = require("express");
const ExcelJS = require("exceljs");
const request = require("supertest");

function parseBinaryResponse(response, callback) {
  const chunks = [];
  response.on("data", (chunk) => chunks.push(chunk));
  response.on("end", () => callback(null, Buffer.concat(chunks)));
}

const orderRow = {
  currentStatus: "shipment_due",
  eventCount: 2,
  firstEventAt: "2026-08-24T02:00:00.000Z",
  itemCount: 1,
  itemSubtotal: 70,
  items: [{ name: "สินค้าทดสอบ", quantity: 1, unitPrice: 70, variant: "1 ขวด" }],
  lastEventAt: "2026-08-24T03:00:00.000Z",
  orderedAt: "2026-08-24T01:00:00.000Z",
  orderNumber: "26082471YK8C02",
  shippingDeadline: "2026-08-30",
  shippingFee: 38,
  shopCode: "sc-drug-store",
  totalAmount: 108,
  totalQuantity: 1,
};

const listOrdersMock = jest.fn(async () => ({ hasMore: true, orders: [orderRow], totalCount: 51 }));
const listOrdersForSalesSummaryMock = jest.fn(async () => [orderRow]);
const getInboxOperationsOverviewMock = jest.fn(async () => ({
  cancelledToday: 2,
  confirmedCodToday: 3,
  lastUpdatedAt: "2026-09-03T01:15:00.000Z",
  ordersToday: 7,
  returnedToday: 1,
  shipmentDueToday: 6,
}));
const getOrderTimelineMock = jest.fn(async () => ({
  events: [{ details: {}, eventType: "shipment_due", id: "event-1", occurredAt: orderRow.lastEventAt }],
  order: orderRow,
}));
const userFinancialVisibility = {
  itemSubtotal: true,
  shippingFee: false,
  totalAmount: false,
  unitPrice: false,
  updatedAt: "2026-09-02T00:00:00.000Z",
  updatedBy: "admin001",
};
const getUserFinancialVisibilityMock = jest.fn(async () => userFinancialVisibility);
const updateUserFinancialVisibilityMock = jest.fn(async (settings, updatedBy) => ({
  ...settings,
  updatedAt: "2026-09-02T01:00:00.000Z",
  updatedBy,
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
  basis: "latest_completed_cycle_with_operational_baseline",
  hasHistory: true,
  lastCompletedCycle: { periodStart: "2026-07-27", periodEnd: "2026-08-23" },
  nextCycle: {
    periodStart: "2026-08-24",
    periodEnd: "2026-09-13",
    weeks: [
      { name: "24-30.08", start: "2026-08-24", end: "2026-08-30" },
      { name: "31.08-06.09", start: "2026-08-31", end: "2026-09-06" },
      { name: "07-13.09", start: "2026-09-07", end: "2026-09-13" },
    ],
  },
  timezone: "Asia/Bangkok",
}));

jest.mock("../src/modules/seamless/db/shopeeOrderRepository", () => ({
  getInboxOperationsOverview: (...args) => getInboxOperationsOverviewMock(...args),
  getOrderTimeline: (...args) => getOrderTimelineMock(...args),
  listOrders: (...args) => listOrdersMock(...args),
  listOrdersForSalesSummary: (...args) => listOrdersForSalesSummaryMock(...args),
}));

jest.mock("../src/modules/seamless/db/shopeeFinancialVisibilityRepository", () => ({
  getUserFinancialVisibility: (...args) => getUserFinancialVisibilityMock(...args),
  updateUserFinancialVisibility: (...args) => updateUserFinancialVisibilityMock(...args),
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
  const response = await request(buildApp()).get(
    "/api/app/shopee/orders?shopCode=sc-drug-store&status=shipment_due&limit=10",
  );

  expect(response.status).toBe(200);
  expect(response.body.orders[0].itemSubtotal).toBe(70);
  expect(response.body.orders[0]).not.toHaveProperty("shippingFee");
  expect(response.body.orders[0]).not.toHaveProperty("totalAmount");
  expect(response.body.orders[0].items[0]).not.toHaveProperty("unitPrice");
  expect(response.body.financialVisibility).toEqual({
    itemSubtotal: true,
    shippingFee: false,
    totalAmount: false,
    unitPrice: false,
  });
  expect(response.body.nextCursor).toEqual(expect.any(String));
  expect(response.body.shopCode).toBe("sc-drug-store");
  expect(listOrdersMock).toHaveBeenCalledWith({
    cursor: null,
    financialVisibility: {
      itemSubtotal: true,
      shippingFee: false,
      totalAmount: false,
      unitPrice: false,
    },
    limit: 10,
    page: null,
    search: null,
    shopCode: "sc-drug-store",
    sortBy: "lastEventAt",
    sortOrder: "desc",
    status: "shipment_due",
  });

  const replay = await request(buildApp()).get(
    `/api/app/shopee/orders?shopCode=dr-morepen&cursor=${response.body.nextCursor}`,
  );
  expect(replay.status).toBe(400);
  expect(replay.body.error.message).toContain("cursor");
});

test("returns a shop-scoped Shopee inbox operations overview for a Bangkok date", async () => {
  const response = await request(buildApp()).get(
    "/api/app/shopee/inbox/overview?shopCode=all&date=2026-09-03",
  );

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    cancelledToday: 2,
    confirmedCodToday: 3,
    date: "2026-09-03",
    ordersToday: 7,
    returnedToday: 1,
    shopCode: "all",
    source: "shopee_order_timeline",
    shipmentDueToday: 6,
    timezone: "Asia/Bangkok",
  });
  expect(getInboxOperationsOverviewMock).toHaveBeenCalledWith({
    date: "2026-09-03",
    shopCode: "all",
  });
});

test("rejects an invalid Shopee inbox overview date", async () => {
  const response = await request(buildApp()).get(
    "/api/app/shopee/inbox/overview?shopCode=all&date=2026-02-30",
  );

  expect(response.status).toBe(400);
  expect(response.body.error.message).toContain("date");
  expect(getInboxOperationsOverviewMock).not.toHaveBeenCalled();
});

test("lists both supported shops without allowing an all-shops cursor to cross scopes", async () => {
  const response = await request(buildApp()).get(
    "/api/app/shopee/orders?shopCode=all&limit=10",
  );

  expect(response.status).toBe(200);
  expect(response.body.shopCode).toBe("all");
  expect(response.body.nextCursor).toEqual(expect.any(String));
  expect(listOrdersMock).toHaveBeenCalledWith({
    cursor: null,
    financialVisibility: {
      itemSubtotal: true,
      shippingFee: false,
      totalAmount: false,
      unitPrice: false,
    },
    limit: 10,
    page: null,
    search: null,
    shopCode: "all",
    sortBy: "lastEventAt",
    sortOrder: "desc",
    status: null,
  });

  const replay = await request(buildApp()).get(
    `/api/app/shopee/orders?shopCode=all&cursor=${response.body.nextCursor}`,
  );
  expect(replay.status).toBe(200);
  expect(listOrdersMock).toHaveBeenLastCalledWith(expect.objectContaining({
    cursor: expect.objectContaining({
      orderNumber: orderRow.orderNumber,
      rowShopCode: "sc-drug-store",
      shopCode: "all",
    }),
    shopCode: "all",
  }));

  const crossScopeReplay = await request(buildApp()).get(
    `/api/app/shopee/orders?shopCode=sc-drug-store&cursor=${response.body.nextCursor}`,
  );
  expect(crossScopeReplay.status).toBe(400);
  expect(crossScopeReplay.body.error.message).toContain("cursor");
});

test("lists a numbered page with bounded database sorting and total metadata", async () => {
  const response = await request(buildApp()).get(
    "/api/app/shopee/orders?shopCode=all&page=2&limit=25&sortBy=orderNumber&sortOrder=asc",
  );

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    nextCursor: null,
    page: 2,
    pageSize: 25,
    shopCode: "all",
    sortBy: "orderNumber",
    sortOrder: "asc",
    totalCount: 51,
    totalPages: 3,
  });
  expect(listOrdersMock).toHaveBeenCalledWith({
    cursor: null,
    financialVisibility: {
      itemSubtotal: true,
      shippingFee: false,
      totalAmount: false,
      unitPrice: false,
    },
    limit: 25,
    page: 2,
    search: null,
    shopCode: "all",
    sortBy: "orderNumber",
    sortOrder: "asc",
    status: null,
  });
});

test("passes one normalized global search term across the full numbered result set", async () => {
  const response = await request(buildApp())
    .get("/api/app/shopee/orders")
    .query({
      limit: 25,
      page: 1,
      search: "  IC-001849   สินค้าทดสอบ  ",
      shopCode: "all",
    });

  expect(response.status).toBe(200);
  expect(response.body.search).toBe("IC-001849 สินค้าทดสอบ");
  expect(listOrdersMock).toHaveBeenCalledWith({
    cursor: null,
    financialVisibility: {
      itemSubtotal: true,
      shippingFee: false,
      totalAmount: false,
      unitPrice: false,
    },
    limit: 25,
    page: 1,
    search: "IC-001849 สินค้าทดสอบ",
    shopCode: "all",
    sortBy: "lastEventAt",
    sortOrder: "desc",
    status: null,
  });
});

test("returns the latest completed cycle and configured next accounting cycle", async () => {
  const response = await request(buildApp()).get("/api/app/shopee/accounting-cycle");

  expect(response.status).toBe(200);
  expect(response.body.lastCompletedCycle.periodEnd).toBe("2026-08-23");
  expect(response.body.nextCycle.periodStart).toBe("2026-08-24");
  expect(response.body.nextCycle.periodEnd).toBe("2026-09-13");
  expect(response.body.nextCycle.weeks).toHaveLength(3);
  expect(getShopeeAccountingCycleStatusMock).toHaveBeenCalledTimes(1);
});

test("returns one order with the shared default financial visibility", async () => {
  const response = await request(buildApp()).get(
    "/api/app/shopee/orders/26082471YK8C02?shopCode=sc-drug-store",
  );

  expect(response.status).toBe(200);
  expect(response.body.order.orderNumber).toBe("26082471YK8C02");
  expect(response.body.events[0].eventType).toBe("shipment_due");
  expect(response.body.financialVisibility.totalAmount).toBe(false);
  expect(response.body.order.itemSubtotal).toBe(70);
  expect(response.body.order).not.toHaveProperty("shippingFee");
  expect(response.body.order).not.toHaveProperty("totalAmount");
  expect(response.body.order.items[0]).not.toHaveProperty("unitPrice");
  expect(getOrderTimelineMock).toHaveBeenCalledWith("sc-drug-store", "26082471YK8C02");
});

test("regular users receive item subtotal only from list and detail APIs", async () => {
  process.env.SEAMLESS_APP_BASIC_USER = "staff001";
  process.env.SEAMLESS_APP_BASIC_PASSWORD = "staff-password";
  process.env.SEAMLESS_APP_ADMIN_BASIC_USER = "admin001";
  process.env.SEAMLESS_APP_ADMIN_BASIC_PASSWORD = "admin-password";

  const [list, detail] = await Promise.all([
    request(buildApp())
      .get("/api/app/shopee/orders?shopCode=sc-drug-store&page=1")
      .auth("staff001", "staff-password"),
    request(buildApp())
      .get(`/api/app/shopee/orders/${orderRow.orderNumber}?shopCode=sc-drug-store`)
      .auth("staff001", "staff-password"),
  ]);

  for (const response of [list, detail]) {
    expect(response.status).toBe(200);
    expect(response.body.financialVisibility).toEqual({
      itemSubtotal: true,
      shippingFee: false,
      totalAmount: false,
      unitPrice: false,
    });
    const order = response.body.order || response.body.orders[0];
    expect(order.itemSubtotal).toBe(70);
    expect(order).not.toHaveProperty("shippingFee");
    expect(order).not.toHaveProperty("totalAmount");
    expect(order.items[0]).not.toHaveProperty("unitPrice");
  }
});

test("regular users receive only financial fields enabled by the saved policy", async () => {
  process.env.SEAMLESS_APP_BASIC_USER = "staff001";
  process.env.SEAMLESS_APP_BASIC_PASSWORD = "staff-password";
  getUserFinancialVisibilityMock.mockResolvedValueOnce({
    ...userFinancialVisibility,
    shippingFee: true,
    unitPrice: true,
  });

  const response = await request(buildApp())
    .get("/api/app/shopee/orders?shopCode=sc-drug-store&page=1")
    .auth("staff001", "staff-password");

  expect(response.status).toBe(200);
  expect(response.body.orders[0].shippingFee).toBe(38);
  expect(response.body.orders[0].items[0].unitPrice).toBe(70);
  expect(response.body.orders[0]).not.toHaveProperty("totalAmount");
});

test("only an admin can read and update regular-user financial visibility", async () => {
  process.env.SEAMLESS_APP_BASIC_USER = "staff001";
  process.env.SEAMLESS_APP_BASIC_PASSWORD = "staff-password";
  process.env.SEAMLESS_APP_ADMIN_BASIC_USER = "admin001";
  process.env.SEAMLESS_APP_ADMIN_BASIC_PASSWORD = "admin-password";
  const settingsPath = "/api/app/shopee/orders/financial-visibility";

  const regular = await request(buildApp())
    .get(settingsPath)
    .auth("staff001", "staff-password");
  expect(regular.status).toBe(403);

  const adminRead = await request(buildApp())
    .get(settingsPath)
    .auth("admin001", "admin-password");
  expect(adminRead.status).toBe(200);
  expect(adminRead.body.userFinancialVisibility).toEqual(userFinancialVisibility);

  const settings = { shippingFee: true, totalAmount: false, unitPrice: true };
  const adminUpdate = await request(buildApp())
    .put(settingsPath)
    .auth("admin001", "admin-password")
    .send(settings);
  expect(adminUpdate.status).toBe(200);
  expect(updateUserFinancialVisibilityMock).toHaveBeenCalledWith(
    { itemSubtotal: true, ...settings },
    "admin001",
  );
});

test("financial visibility rejects incomplete or unknown settings", async () => {
  process.env.SEAMLESS_APP_ADMIN_BASIC_USER = "admin001";
  process.env.SEAMLESS_APP_ADMIN_BASIC_PASSWORD = "admin-password";
  const settingsPath = "/api/app/shopee/orders/financial-visibility";

  const [incomplete, unknown] = await Promise.all([
    request(buildApp())
      .put(settingsPath)
      .auth("admin001", "admin-password")
      .send({ shippingFee: true, totalAmount: false }),
    request(buildApp())
      .put(settingsPath)
      .auth("admin001", "admin-password")
      .send({ shippingFee: true, totalAmount: false, unitPrice: false, buyer: true }),
  ]);

  expect(incomplete.status).toBe(400);
  expect(incomplete.body.error.message).toContain("unitPrice");
  expect(unknown.status).toBe(400);
  expect(unknown.body.error.message).toContain("buyer");
});

test("summarizes sold products by order date and defaults a blank end date to start date", async () => {
  const response = await request(buildApp()).get(
    "/api/app/shopee/orders/sales-summary?shopCode=all&startDate=2026-08-24",
  );

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    endDate: "2026-08-24",
    excludedStatuses: ["order_cancelled", "seller_return_delivery"],
    orderCount: 1,
    productCount: 1,
    shopCode: "all",
    startDate: "2026-08-24",
    timezone: "Asia/Bangkok",
    totalQuantity: 1,
  });
  expect(response.body.products[0]).toMatchObject({
    name: "สินค้าทดสอบ",
    orderCount: 1,
    totalQuantity: 1,
    variant: "1 ขวด",
  });
  expect(listOrdersForSalesSummaryMock).toHaveBeenCalledWith({
    endDate: "2026-08-24",
    shopCode: "all",
    startDate: "2026-08-24",
  });
});

test("downloads the selected sales-summary range as an Excel workbook", async () => {
  listOrdersForSalesSummaryMock.mockResolvedValueOnce([{
    ...orderRow,
    items: [{
      ...orderRow.items[0],
      productMatch: { companySku: "IC-TEST", status: "matched" },
    }],
  }]);

  const response = await request(buildApp()).get(
    "/api/app/shopee/orders/sales-summary/export?shopCode=sc-drug-store&startDate=2026-08-24&endDate=2026-08-25",
  ).buffer(true).parse(parseBinaryResponse);

  expect(response.status).toBe(200);
  expect(response.headers["content-type"]).toContain(
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  expect(response.headers["content-disposition"]).toContain(
    "shopee-sales-sc-drug-store-2026-08-24-to-2026-08-25.xlsx",
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(response.body);
  expect(workbook.getWorksheet("พร้อมคีย์").getCell("C2").value).toBe("IC-TEST");
  expect(listOrdersForSalesSummaryMock).toHaveBeenCalledWith({
    endDate: "2026-08-25",
    shopCode: "sc-drug-store",
    startDate: "2026-08-24",
  });
});

test.each([
  ["shopCode=all", "startDate"],
  ["shopCode=all&startDate=2026-02-30", "startDate"],
  ["shopCode=all&startDate=2026-08-24&endDate=2026-08-23", "endDate"],
])("rejects invalid sales-summary dates: %s", async (query, messagePart) => {
  const response = await request(buildApp()).get(`/api/app/shopee/orders/sales-summary?${query}`);

  expect(response.status).toBe(400);
  expect(response.body.error.message).toContain(messagePart);
  expect(listOrdersForSalesSummaryMock).not.toHaveBeenCalled();
});

test("allows only an admin session to sync full Gmail bodies into the timeline", async () => {
  process.env.SEAMLESS_APP_BASIC_USER = "staff001";
  process.env.SEAMLESS_APP_BASIC_PASSWORD = "staff-password";
  process.env.SEAMLESS_APP_ADMIN_BASIC_USER = "admin001";
  process.env.SEAMLESS_APP_ADMIN_BASIC_PASSWORD = "admin-password";

  const regular = await request(buildApp())
    .post("/api/app/shopee/orders/sync")
    .auth("staff001", "staff-password")
    .send({ limit: 10, shopCode: "sc-drug-store" });
  expect(regular.status).toBe(403);
  expect(syncShopeeOrderPageMock).not.toHaveBeenCalled();

  const admin = await request(buildApp())
    .post("/api/app/shopee/orders/sync")
    .auth("admin001", "admin-password")
    .send({ cursor: "gmail-page", limit: 10, shopCode: "sc-drug-store" });
  expect(admin.status).toBe(200);
  expect(syncShopeeOrderPageMock).toHaveBeenCalledWith({
    cursor: "gmail-page",
    limit: 10,
    shopCode: "sc-drug-store",
  });
});

test("routes an admin DR.Morepen sync to the dedicated mailbox config", async () => {
  process.env.SEAMLESS_APP_ADMIN_BASIC_USER = "admin001";
  process.env.SEAMLESS_APP_ADMIN_BASIC_PASSWORD = "admin-password";

  const response = await request(buildApp())
    .post("/api/app/shopee/orders/sync")
    .auth("admin001", "admin-password")
    .send({ limit: 10, shopCode: "dr-morepen" });

  expect(response.status).toBe(200);
  expect(syncShopeeOrderPageMock).toHaveBeenCalledWith({
    limit: 10,
    shopCode: "dr-morepen",
  });
});

test("keeps all-shops scope read-only and rejects it for detail and sync", async () => {
  process.env.SEAMLESS_APP_ADMIN_BASIC_USER = "admin001";
  process.env.SEAMLESS_APP_ADMIN_BASIC_PASSWORD = "admin-password";

  const [detail, sync] = await Promise.all([
    request(buildApp()).get(`/api/app/shopee/orders/${orderRow.orderNumber}?shopCode=all`),
    request(buildApp())
      .post("/api/app/shopee/orders/sync")
      .auth("admin001", "admin-password")
      .send({ limit: 10, shopCode: "all" }),
  ]);

  expect(detail.status).toBe(400);
  expect(sync.status).toBe(400);
  expect(syncShopeeOrderPageMock).not.toHaveBeenCalled();
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
    .send({ limit: 25, shopCode: "sc-drug-store" });

  expect(response.status).toBe(409);
  expect(response.body.error.message).toContain("already running");
});

test.each([
  ["/api/app/shopee/orders?shopCode=sc-drug-store&status=unknown", "status"],
  ["/api/app/shopee/orders?shopCode=sc-drug-store&limit=26", "limit"],
  ["/api/app/shopee/orders?shopCode=sc-drug-store&page=0", "page"],
  ["/api/app/shopee/orders?shopCode=sc-drug-store&sortBy=buyer", "sortBy"],
  ["/api/app/shopee/orders?shopCode=sc-drug-store&sortOrder=sideways", "sortOrder"],
  ["/api/app/shopee/orders?shopCode=sc-drug-store&page=2&cursor=broken", "cursor and page"],
  ["/api/app/shopee/orders?shopCode=sc-drug-store&search=test&cursor=broken", "cursor and search"],
  [`/api/app/shopee/orders?shopCode=sc-drug-store&search=${"x".repeat(121)}`, "search"],
  ["/api/app/shopee/orders?shopCode=sc-drug-store&cursor=broken", "cursor"],
  ["/api/app/shopee/orders/SHORT?shopCode=sc-drug-store", "orderNumber"],
  ["/api/app/shopee/orders/not-valid!?shopCode=sc-drug-store", "orderNumber"],
])("rejects invalid timeline request %s", async (path, messagePart) => {
  const response = await request(buildApp()).get(path);
  expect(response.status).toBe(400);
  expect(response.body.error.message).toContain(messagePart);
});

test("requires an explicit supported shop for list, detail, and admin sync", async () => {
  process.env.SEAMLESS_APP_ADMIN_BASIC_USER = "admin001";
  process.env.SEAMLESS_APP_ADMIN_BASIC_PASSWORD = "admin-password";

  const [list, detail, sync] = await Promise.all([
    request(buildApp()).get("/api/app/shopee/orders"),
    request(buildApp()).get("/api/app/shopee/orders/26082471YK8C02"),
    request(buildApp())
      .post("/api/app/shopee/orders/sync")
      .auth("admin001", "admin-password")
      .send({ limit: 25 }),
  ]);

  expect([list.status, detail.status, sync.status]).toEqual([400, 400, 400]);
  expect(list.body.error.details.code).toBe("SHOPEE_SHOP_REQUIRED");
  expect(detail.body.error.details.code).toBe("SHOPEE_SHOP_REQUIRED");
  expect(sync.body.error.details.code).toBe("SHOPEE_SHOP_REQUIRED");
});
