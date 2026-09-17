const express = require("express");
const request = require("supertest");

const mockIngestShopeeSalesSource = jest.fn();
const mockRecordDocumentObservation = jest.fn();
jest.mock("../src/modules/seamless/services/shopeeDocumentObservationService", () => ({
  recordDocumentObservation: (...args) => mockRecordDocumentObservation(...args),
}));
jest.mock("../src/modules/seamless/services/shopeeSalesIngestService", () => ({
  MAX_PROVENANCE_JSON_BYTES: 32 * 1024,
  MAX_SOURCE_BYTES: 20 * 1024 * 1024,
  ingestShopeeSalesSource: (...args) => mockIngestShopeeSalesSource(...args),
}));
jest.mock("../src/modules/seamless/controllers/agentController", () => ({
  completePrintJob: jest.fn(),
  createPrintJob: jest.fn(),
  getPrintQueue: jest.fn(),
  updatePrintJob: jest.fn(),
}));

const agentRoutes = require("../src/modules/seamless/routes/agentRoutes");
const { errorHandler } = require("../src/modules/seamless/middleware/errorHandler");

function app() {
  const value = express();
  value.use("/api/agent", agentRoutes);
  value.use(errorHandler);
  return value;
}

function validRequest(value, token = "dedicated-ingest-test-token") {
  return value
    .post("/api/agent/shopee/sales-sources")
    .set("Authorization", `Bearer ${token}`)
    // The 000-HQ native FormData client appends the binary part first.
    .attach("file", Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]), {
      filename: "Order.all.20260908_20260908.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })
    .field("shopCode", "sc-drug-store")
    .field("reportType", "orders")
    .field("dateFrom", "2026-09-08")
    .field("dateTo", "2026-09-08")
    .field("originalFilename", "Order.all.20260908_20260908.xlsx")
    .field("observedAt", "2026-09-09T02:00:00.000Z")
    .field("sha256", "a".repeat(64))
    .field("jobId", "20260909090000-orders-12345678");
}

beforeEach(() => {
  process.env.SHOPEE_SALES_INGEST_TOKEN = "dedicated-ingest-test-token";
  mockIngestShopeeSalesSource.mockReset();
  mockRecordDocumentObservation.mockReset();
});

test("metadata observations require the dedicated bearer and accept JSON without a file", async () => {
  const path = "/api/agent/shopee/document-observations";
  expect((await request(app()).post(path).send({})).status).toBe(401);
  delete process.env.SHOPEE_SALES_INGEST_TOKEN;
  expect((await request(app()).post(path).send({})).status).toBe(503);
  expect(mockRecordDocumentObservation).not.toHaveBeenCalled();
  process.env.SHOPEE_SALES_INGEST_TOKEN = "dedicated-ingest-test-token";
  mockRecordDocumentObservation.mockResolvedValue({ status: "recorded", resultStatus: "no_file" });
  const response = await request(app()).post(path)
    .set("Authorization", "Bearer dedicated-ingest-test-token").send({ resultStatus: "no_file" });
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(mockRecordDocumentObservation).toHaveBeenCalledWith({ body: { resultStatus: "no_file" } });
});

afterAll(() => {
  delete process.env.SHOPEE_SALES_INGEST_TOKEN;
});

test("agent endpoint fails closed when its dedicated server token is absent", async () => {
  delete process.env.SHOPEE_SALES_INGEST_TOKEN;
  const response = await request(app()).post("/api/agent/shopee/sales-sources");
  expect(response.status).toBe(503);
  expect(response.body.error.code).toBe("SERVICE_UNAVAILABLE");
  expect(mockIngestShopeeSalesSource).not.toHaveBeenCalled();
});

test("agent endpoint rejects a wrong bearer token before parsing multipart bytes", async () => {
  const response = await validRequest(request(app()), "wrong-token");
  expect(response.status).toBe(401);
  expect(response.body.error.code).toBe("UNAUTHORIZED");
  expect(JSON.stringify(response.body)).not.toContain("dedicated-ingest-test-token");
  expect(mockIngestShopeeSalesSource).not.toHaveBeenCalled();
});

test("agent endpoint accepts one XLSX and returns an idempotent import result", async () => {
  mockIngestShopeeSalesSource.mockResolvedValue({
    status: "imported",
    sha256: "a".repeat(64),
    sourceFilename: "Order.all.20260908_20260908.xlsx",
    importedAt: "2026-09-09T02:01:00.000Z",
  });
  const response = await validRequest(request(app()));
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.body.status).toBe("imported");
  expect(mockIngestShopeeSalesSource).toHaveBeenCalledTimes(1);
  const input = mockIngestShopeeSalesSource.mock.calls[0][0];
  expect(input.body.originalFilename).toBe("Order.all.20260908_20260908.xlsx");
  expect(input.file.originalname).toBe(input.body.originalFilename);
});

test("agent endpoint accepts the bounded assembled return contract without fabricating originalFilename", async () => {
  const archiveFilename = "assembled.Order.return_refund_cancel.20260912_20260913.zip";
  const sourceOriginalFiles = JSON.stringify([
    { originalFilename: "Order.cancelled.20260912_20260913_part_1_of_1.xlsx", bytes: 10,
      sha256: "a".repeat(64), kind: "cancelled", extension: "xlsx", part: 1, totalParts: 1 },
    { originalFilename: "Order.return_refund.20260912_20260913_part_1_of_1.xls", bytes: 10,
      sha256: "b".repeat(64), kind: "return_refund", extension: "xls", part: 1, totalParts: 1 },
    { originalFilename: "Order.failed_delivery.20260912_20260913_part_1_of_1.xlsx", bytes: 10,
      sha256: "c".repeat(64), kind: "failed_delivery", extension: "xlsx", part: 1, totalParts: 1 },
  ]);
  mockIngestShopeeSalesSource.mockResolvedValue({
    status: "imported",
    sourceFilename: archiveFilename,
    assembledProvenance: { assembledFromOfficialComponents: true, archiveFilename },
  });
  const response = await request(app())
    .post("/api/agent/shopee/sales-sources")
    .set("Authorization", "Bearer dedicated-ingest-test-token")
    .attach("file", Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]), {
      filename: archiveFilename, contentType: "application/zip",
    })
    .field("shopCode", "sc-drug-store")
    .field("reportType", "return-refund-cancel")
    .field("dateFrom", "2026-09-12")
    .field("dateTo", "2026-09-12")
    .field("assembledFromOfficialComponents", "true")
    .field("archiveFilename", archiveFilename)
    .field("sourceOriginalFiles", sourceOriginalFiles)
    .field("observedAt", "2026-09-13T02:00:00.000Z")
    .field("sha256", "d".repeat(64))
    .field("jobId", "20260913090000-return-refund-cancel-assembled");
  expect(response.status).toBe(200);
  const input = mockIngestShopeeSalesSource.mock.calls[0][0];
  expect(input.body.originalFilename).toBeUndefined();
  expect(input.body.archiveFilename).toBe(archiveFilename);
  expect(input.file.originalname).toBe(archiveFilename);
});

test("agent endpoint rejects oversized assembled provenance before service parsing", async () => {
  const archiveFilename = "assembled.Order.return_refund_cancel.20260912_20260913.zip";
  const response = await request(app())
    .post("/api/agent/shopee/sales-sources")
    .set("Authorization", "Bearer dedicated-ingest-test-token")
    .attach("file", Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]), {
      filename: archiveFilename, contentType: "application/zip",
    })
    .field("sourceOriginalFiles", "x".repeat(33 * 1024));
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe("LIMIT_FIELD_VALUE");
  expect(mockIngestShopeeSalesSource).not.toHaveBeenCalled();
});
