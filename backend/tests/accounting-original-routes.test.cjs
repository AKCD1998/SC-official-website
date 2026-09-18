const express = require("express");
const request = require("supertest");
jest.mock(
  "../src/modules/seamless/services/accountingOriginalPrintService",
  () => ({
    createBatch: jest.fn(),
    getBatch: jest.fn(),
    listBatches: jest.fn(),
    capabilities: jest.fn(),
    approveBatch: jest.fn(),
    resolvePaused: jest.fn(),
    getFile: jest.fn(),
    claimWork: jest.fn(),
    updateWork: jest.fn(),
  }),
);
jest.mock(
  "../src/modules/seamless/db/accountingIncomeOrderRepository",
  () => ({ listIncomeOrders: jest.fn() }),
);
jest.mock(
  "../src/modules/seamless/services/accountingIncomeExportService",
  () => ({
    exportAccountingIncomeOrders: jest.fn(),
    previewAccountingIncomeOrders: jest.fn(),
  }),
);
const service = require("../src/modules/seamless/services/accountingOriginalPrintService");
const incomeOrderRepository = require("../src/modules/seamless/db/accountingIncomeOrderRepository");
const incomeExportService = require("../src/modules/seamless/services/accountingIncomeExportService");
const routes = require("../src/modules/seamless/routes/accountingPrintBundleRoutes");
const agentRoutes = require("../src/modules/seamless/routes/accountingPrintAgentRoutes");
const {
  errorHandler,
} = require("../src/modules/seamless/middleware/errorHandler");
const app = express();
app.use(express.json());
app.use("/batches", routes);
app.use("/agent", agentRoutes);
app.use(errorHandler);
beforeEach(() => {
  jest.clearAllMocks();
  process.env.SEAMLESS_ACCOUNTING_BATCH_ENABLED = "true";
  process.env.SEAMLESS_APP_BASIC_USER = "staff";
  process.env.SEAMLESS_APP_BASIC_PASSWORD = "staff-test";
  process.env.SEAMLESS_APP_ADMIN_BASIC_USER = "admin";
  process.env.SEAMLESS_APP_ADMIN_BASIC_PASSWORD = "admin-test";
  process.env.SEAMLESS_INTERNAL_API_TOKEN = "agent-test";
  incomeOrderRepository.listIncomeOrders.mockResolvedValue({
    orders: [{
      amount: 125.5,
      orderDate: "2026-08-31",
      orderNumber: "260901TEST001",
      sellerBalanceNetAmount: 125.5,
      sellerBalanceStatus: "credited",
      sellerBalanceInflowDate: "2026-09-01",
      shopCode: "sc-drug-store",
      transferDate: "2026-09-01",
    }],
    totalCount: 1,
  });
  incomeExportService.exportAccountingIncomeOrders.mockResolvedValue({
    buffer: Buffer.from("xlsx-test"),
    filename: "shopee-income-accounting-2026-08-01-to-2026-08-31.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  incomeExportService.previewAccountingIncomeOrders.mockResolvedValue({
    documents: [],
    filters: { shopCode: "sc-drug-store", shopLabel: "SC Drug Store" },
    orders: [{ orderNumber: "260901TEST001", shopCode: "sc-drug-store" }],
    summary: { creditedCount: 1, orderCount: 1, totalIncome: 125.5 },
    timezone: "Asia/Bangkok",
  });
});
afterEach(() => {
  for (const name of [
    "SEAMLESS_ACCOUNTING_BATCH_ENABLED",
    "SEAMLESS_APP_BASIC_USER",
    "SEAMLESS_APP_BASIC_PASSWORD",
    "SEAMLESS_APP_ADMIN_BASIC_USER",
    "SEAMLESS_APP_ADMIN_BASIC_PASSWORD",
    "SEAMLESS_INTERNAL_API_TOKEN",
  ])
    delete process.env[name];
});
test("upload requires admin before receiving file data", async () => {
  const result = await request(app)
    .post("/batches")
    .auth("staff", "staff-test")
    .attach("sc-drug-store", Buffer.from("pdf"), "weekly_report_20260727.pdf");
  expect(result.status).toBe(403);
  expect(service.createBatch).not.toHaveBeenCalled();
});
test("admin upload preserves identical filenames from different shop fields", async () => {
  service.createBatch.mockResolvedValue({ id: "batch" });
  const result = await request(app)
    .post("/batches")
    .auth("admin", "admin-test")
    .attach(
      "sc-drug-store",
      Buffer.from("shop A"),
      "weekly_report_20260727.pdf",
    )
    .attach("dr-morepen", Buffer.from("shop B"), "weekly_report_20260727.pdf");
  expect(result.status).toBe(201);
  const [files, actor] = service.createBatch.mock.calls[0];
  expect(actor).toBe("admin");
  expect(files.map((f) => f.fieldname)).toEqual([
    "sc-drug-store",
    "dr-morepen",
  ]);
  expect(files.map((f) => f.buffer.toString())).toEqual(["shop A", "shop B"]);
});
test("staff cannot approve or resolve a stopped print batch", async () => {
  expect(
    (
      await request(app)
        .post("/batches/id/approve")
        .auth("staff", "staff-test")
        .send({ digest: "x" })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(app)
        .post("/batches/id/resolve")
        .auth("staff", "staff-test")
        .send({ action: "retry" })
    ).status,
  ).toBe(403);
  expect(service.approveBatch).not.toHaveBeenCalled();
});
test("anonymous file downloads and non-agent queue claims are rejected", async () => {
  expect(
    (await request(app).get("/batches/id/items/item/original")).status,
  ).toBe(401);
  expect((await request(app).post("/agent/claim").send({})).status).toBe(401);
  expect(service.getFile).not.toHaveBeenCalled();
  expect(service.claimWork).not.toHaveBeenCalled();
});
test("feature remains unavailable until enabled", async () => {
  process.env.SEAMLESS_ACCOUNTING_BATCH_ENABLED = "false";
  expect(
    (await request(app).get("/batches").auth("admin", "admin-test")).status,
  ).toBe(503);
  expect(service.listBatches).not.toHaveBeenCalled();
});

test("lists Income orders through the named authenticated route with shared filters", async () => {
  const result = await request(app)
    .get("/batches/income-orders")
    .query({
      dateColumn: "orderedAt",
      dateFrom: "2026-08-30",
      dateTo: "2026-08-31",
      orderNumber: "260901test",
      page: 2,
      pageSize: 10,
      shopCode: "sc-drug-store",
    })
    .auth("staff", "staff-test");
  expect(result.status).toBe(200);
  expect(result.headers["cache-control"]).toBe("private, no-store");
  expect(result.body).toMatchObject({
    orders: [{
      sellerBalanceNetAmount: 125.5,
      sellerBalanceStatus: "credited",
      sellerBalanceInflowDate: "2026-09-01",
    }],
    page: 2,
    pageSize: 10,
    timezone: "Asia/Bangkok",
    totalCount: 1,
  });
  expect(result.body.orders[0].shopCode).toBe("sc-drug-store");
  expect(result.body.orders[0]).not.toHaveProperty("buyerUsername");
  expect(incomeOrderRepository.listIncomeOrders).toHaveBeenCalledWith({
    dateColumn: "orderedAt",
    dateFrom: "2026-08-30",
    dateTo: "2026-08-31",
    orderNumber: "260901TEST",
    page: 2,
    pageSize: 10,
    shopCode: "sc-drug-store",
  });
});

test("rejects invalid Income order ranges before querying the database", async () => {
  const result = await request(app)
    .get("/batches/income-orders?dateFrom=2026-09-02&dateTo=2026-09-01")
    .auth("staff", "staff-test");
  expect(result.status).toBe(400);
  expect(result.body.error.message).toContain("dateTo");
  const invalidShop = await request(app)
    .get("/batches/income-orders?shopCode=unknown-shop")
    .auth("staff", "staff-test");
  expect(invalidShop.status).toBe(400);
  expect(invalidShop.body.error.message).toContain("shopCode");
  expect(incomeOrderRepository.listIncomeOrders).not.toHaveBeenCalled();
});

test("exports the selected transferred-date range as an authenticated accounting workbook", async () => {
  const result = await request(app)
    .get("/batches/income-orders/export.xlsx")
    .query({
      dateColumn: "transferredAt",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-31",
      orderNumber: "2608test",
      shopCode: "dr-morepen",
    })
    .set("X-Forwarded-Proto", "https")
    .set("X-Forwarded-Host", "api.example.test")
    .auth("staff", "staff-test");

  expect(result.status).toBe(200);
  expect(result.headers["cache-control"]).toBe("private, no-store");
  expect(result.headers["content-type"]).toContain(
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  expect(result.headers["content-disposition"]).toContain(
    "shopee-income-accounting-2026-08-01-to-2026-08-31.xlsx",
  );
  expect(incomeExportService.exportAccountingIncomeOrders).toHaveBeenCalledWith({
    dateColumn: "transferredAt",
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
    orderNumber: "2608TEST",
    shopCode: "dr-morepen",
  }, { publicOrigin: "https://api.example.test" });
});

test("previews the selected shop and range before any workbook download", async () => {
  const result = await request(app)
    .get("/batches/income-orders/preview")
    .query({
      dateColumn: "transferredAt",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-31",
      shopCode: "sc-drug-store",
    })
    .set("X-Forwarded-Proto", "https")
    .set("X-Forwarded-Host", "api.example.test")
    .auth("staff", "staff-test");

  expect(result.status).toBe(200);
  expect(result.headers["cache-control"]).toBe("private, no-store");
  expect(result.body.filters.shopLabel).toBe("SC Drug Store");
  expect(incomeExportService.previewAccountingIncomeOrders).toHaveBeenCalledWith({
    dateColumn: "transferredAt",
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
    orderNumber: "",
    shopCode: "sc-drug-store",
  }, { publicOrigin: "https://api.example.test" });
  expect(incomeExportService.exportAccountingIncomeOrders).not.toHaveBeenCalled();
});

test("Income accounting export rejects order-date basis and missing date bounds", async () => {
  const orderDateResult = await request(app)
    .get("/batches/income-orders/export.xlsx?dateColumn=orderedAt&dateFrom=2026-08-01&dateTo=2026-08-31")
    .auth("staff", "staff-test");
  const missingDateResult = await request(app)
    .get("/batches/income-orders/export.xlsx?dateColumn=transferredAt")
    .auth("staff", "staff-test");

  expect(orderDateResult.status).toBe(400);
  expect(orderDateResult.body.error.message).toContain("transferredAt");
  expect(missingDateResult.status).toBe(400);
  expect(missingDateResult.body.error.message).toContain("dateFrom");
  expect(incomeExportService.exportAccountingIncomeOrders).not.toHaveBeenCalled();
});
