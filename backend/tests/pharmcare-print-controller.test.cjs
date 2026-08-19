const express = require("express");
const request = require("supertest");

jest.mock("../src/modules/seamless/services/pharmcarePrintService", () => ({
  requestPharmcarePrint: jest.fn(),
}));

const { requestPharmcarePrint } = require("../src/modules/seamless/services/pharmcarePrintService");
const { requestPrint } = require("../src/modules/seamless/controllers/pharmcarePrintController");
const { errorHandler } = require("../src/modules/seamless/middleware/errorHandler");

function buildApp(appRole) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.appRole = appRole;
    next();
  });
  app.post("/documents/:id/print", async (req, res, next) => {
    try {
      await requestPrint(req, res);
    } catch (error) {
      next(error);
    }
  });
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  requestPharmcarePrint.mockReset();
});

describe("pharmcarePrintController.requestPrint", () => {
  test("rejects a non-admin session with 403 before calling the service", async () => {
    const app = buildApp("user");

    const response = await request(app).post("/documents/doc-1/print").send({});

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(requestPharmcarePrint).not.toHaveBeenCalled();
  });

  test("rejects a session with no role at all (should never happen, but must not default-allow)", async () => {
    const app = buildApp(undefined);

    const response = await request(app).post("/documents/doc-1/print").send({});

    expect(response.status).toBe(403);
    expect(requestPharmcarePrint).not.toHaveBeenCalled();
  });

  test("an admin session calls the service with the document id and passes through requestedBy/reason", async () => {
    requestPharmcarePrint.mockResolvedValue({ ok: true, message: "Print requested.", record: {}, job: {} });
    const app = buildApp("admin");

    const response = await request(app)
      .post("/documents/doc-1/print")
      .send({ requestedBy: "someone", reason: "manual retry" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, message: "Print requested.", record: {}, job: {} });
    expect(requestPharmcarePrint).toHaveBeenCalledWith("doc-1", {
      requestedBy: "someone",
      reason: "manual retry",
    });
  });

  test("an admin session with no body still succeeds with empty requestedBy/reason", async () => {
    requestPharmcarePrint.mockResolvedValue({ ok: true, message: "Print requested.", record: {}, job: {} });
    const app = buildApp("admin");

    const response = await request(app).post("/documents/doc-1/print").send();

    expect(response.status).toBe(200);
    expect(requestPharmcarePrint).toHaveBeenCalledWith("doc-1", { requestedBy: "", reason: "" });
  });

  test("propagates a service error (e.g. document not found) through the error handler", async () => {
    const { notFound } = require("../src/modules/seamless/errors");
    requestPharmcarePrint.mockRejectedValue(notFound("PharmCare document not found for id: doc-missing"));
    const app = buildApp("admin");

    const response = await request(app).post("/documents/doc-missing/print").send({});

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
