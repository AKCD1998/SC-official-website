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
const service = require("../src/modules/seamless/services/accountingOriginalPrintService");
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
