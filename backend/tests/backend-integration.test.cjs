const { spawn, spawnSync } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const express = require("express");
const request = require("supertest");

const backendRoot = path.resolve(__dirname, "..");
const serverEntry = path.join(backendRoot, "server.js");

jest.setTimeout(30000);

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function waitForServer(child, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Timed out waiting for backend to start. Output:\n${output}`));
    }, timeoutMs);

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(output);
    }

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("Server is running on port")) {
        finish();
      }
    });

    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.on("error", finish);
    child.on("exit", (code) => {
      if (!settled) {
        finish(new Error(`Backend exited before startup with code ${code}. Output:\n${output}`));
      }
    });
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    const fallback = setTimeout(resolve, 3000);
    child.once("exit", () => {
      clearTimeout(fallback);
      resolve();
    });
    child.kill();
  });
}

function testEnv(extra = {}) {
  return {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: "",
    JWT_SECRET: "test-only-main-secret",
    OTP_SECRET: "test-only-otp-secret",
    SENDGRID_API_KEY: "SG.test-only-placeholder",
    REACTNJOB_SENDGRID_API_KEY: "SG.test-only-reactnjob-placeholder",
    MAIL_USER: "sender@example.com",
    MAIL_TO: "receiver@example.com",
    REACTNJOB_SUBMIT_URL: "",
    REACTNJOB_QUICK_CV_SUBMIT_URL: "",
    REACTNJOB_HR_EMAIL: "",
    REACTNJOB_FROM_EMAIL: "",
    REACTNJOB_LINE_CHANNEL_SECRET: "test-only-reactnjob-secret",
    REACTNJOB_LINE_CHANNEL_ACCESS_TOKEN: "",
    REACTNJOB_LINE_NOTIFY_MODE: "",
    REACTNJOB_LINE_NOTIFY_USER_IDS: "",
    LINE_CHANNEL_SECRET: "",
    LINE_CHANNEL_ACCESS_TOKEN: "",
    LINE_NOTIFY_MODE: "",
    LINE_NOTIFY_USER_IDS: "",
    RX1011_DATABASE_URL: "",
    RX1011_JWT_SECRET: "test-only-rx1011-secret",
    ...extra,
  };
}

describe("Rx1011 module import baseline", () => {
  test("database layer, route entrypoint, controllers, and middleware import safely", () => {
    const script = `
      process.env.RX1011_DATABASE_URL = "";
      process.env.DATABASE_URL = "";
      process.env.RX1011_JWT_SECRET = "test-only";
      await import("./src/modules/rx1011/db/pool.js");
      await import("./src/modules/rx1011/index.js");
      await import("./src/modules/rx1011/controllers/authController.js");
      await import("./src/modules/rx1011/controllers/adminController.js");
      await import("./src/modules/rx1011/controllers/adminIncidentsController.js");
      await import("./src/modules/rx1011/controllers/adminPatientsController.js");
      await import("./src/modules/rx1011/controllers/dispenseController.js");
      await import("./src/modules/rx1011/controllers/inventoryController.js");
      await import("./src/modules/rx1011/controllers/organicReportsController.js");
      await import("./src/modules/rx1011/controllers/productsController.js");
      await import("./src/modules/rx1011/controllers/helpers.js");
      await import("./src/modules/rx1011/controllers/incidentResolutionHelpers.js");
      await import("./src/modules/rx1011/middleware/authMiddleware.js");
      console.log("ok");
    `;

    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: backendRoot,
      env: testEnv(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ok");
  });
});

describe("ReactNJob module import baseline", () => {
  test("route entrypoint imports and creates a router safely", () => {
    const createReactNJobRouter = require("../src/modules/reactnjob");
    const router = createReactNJobRouter();

    expect(typeof createReactNJobRouter).toBe("function");
    expect(typeof router).toBe("function");
  });

  test("ReactNJob SendGrid config ignores the shared SENDGRID_API_KEY", async () => {
    const previous = {
      SENDGRID_API_KEY: process.env.SENDGRID_API_KEY,
      REACTNJOB_SENDGRID_API_KEY: process.env.REACTNJOB_SENDGRID_API_KEY,
    };

    process.env.SENDGRID_API_KEY = "SG.shared-only-placeholder";
    delete process.env.REACTNJOB_SENDGRID_API_KEY;

    try {
      const createReactNJobRouter = require("../src/modules/reactnjob");
      const app = express();
      app.use("/api/reactnjob", createReactNJobRouter());

      const response = await request(app).post("/api/reactnjob/resume").send({});

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        ok: false,
        error: "Missing REACTNJOB_SENDGRID_API_KEY",
      });
    } finally {
      if (previous.SENDGRID_API_KEY === undefined) delete process.env.SENDGRID_API_KEY;
      else process.env.SENDGRID_API_KEY = previous.SENDGRID_API_KEY;

      if (previous.REACTNJOB_SENDGRID_API_KEY === undefined) {
        delete process.env.REACTNJOB_SENDGRID_API_KEY;
      } else {
        process.env.REACTNJOB_SENDGRID_API_KEY = previous.REACTNJOB_SENDGRID_API_KEY;
      }
    }
  });
});

describe("target backend and Rx1011 namespace", () => {
  let child;
  let api;

  beforeAll(async () => {
    const port = await getFreePort();
    child = spawn(process.execPath, [serverEntry], {
      cwd: backendRoot,
      env: testEnv({ PORT: String(port), CORS_ORIGIN: "http://localhost:5173" }),
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitForServer(child);
    api = request(`http://127.0.0.1:${port}`);
  });

  afterAll(async () => {
    await stopServer(child);
  });

  test("target backend starts and existing health routes still work", async () => {
    await api.get("/").expect(200, "Server is running");
    await api.get("/health").expect(200, { ok: true });
    await api.get("/api/health").expect(200, { ok: true });
    await api.get("/api/auth/ping").expect(200, { ok: true });
  });

  test("existing target routes keep baseline validation behavior", async () => {
    const contact = await api.post("/api/contact").send({});
    expect(contact.status).toBe(400);
    expect(contact.body).toEqual({ error: "All fields are required." });

    const login = await api.post("/api/auth/login").send({});
    expect(login.status).toBe(400);
    expect(login.body).toEqual({ error: "Email and password are required." });

    const me = await api.get("/api/auth/me");
    expect(me.status).toBe(401);
    expect(me.body).toEqual({ error: "Missing token." });
  });

  test("Rx1011 health route is mounted under the new namespace", async () => {
    const response = await api.get("/api/rx1011/health");

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      ok: false,
      database: {
        ok: false,
        message: "RX1011_DATABASE_URL or DATABASE_URL is not set",
      },
    });
  });

  test("Rx1011 patients CSV fallback works under the new namespace", async () => {
    const response = await api.get("/api/rx1011/patients");

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);
  });

  test("Rx1011 unknown routes return the namespaced JSON 404", async () => {
    const response = await api.get("/api/rx1011/not-a-real-route");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Not found" });
  });

  test.each([
    ["POST", "/api/rx1011/auth/login", {}, 400],
    ["POST", "/api/rx1011/auth/logout", {}, 401],
    ["GET", "/api/rx1011/admin/patients", null, 401],
    ["POST", "/api/rx1011/inventory/receive", {}, 401],
    ["GET", "/api/rx1011/dispense/history", null, 401],
    ["GET", "/api/rx1011/stock/on-hand", null, 401],
    ["GET", "/api/rx1011/products", null, 500],
    ["GET", "/api/rx1011/products/version", null, 500],
    ["GET", "/api/rx1011/active-ingredients", null, 500],
  ])("%s %s returns the current Rx1011 baseline status", async (method, route, body, status) => {
    const response =
      method === "POST" ? await api.post(route).send(body || {}) : await api.get(route);

    expect(response.status).toBe(status);
    expect(response.type).toMatch(/json/);
  });

  test("ReactNJob routes are mounted under the new namespace", async () => {
    await api.get("/api/reactnjob/").expect(200, "OK");
    await api.get("/api/reactnjob/health").expect(200, { ok: true });

    const unknown = await api.get("/api/reactnjob/not-a-real-route");
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: "Not found" });
  });

  test("ReactNJob LINE webhook preserves raw-body signature behavior", async () => {
    const response = await api.post("/api/reactnjob/line/webhook").send({ events: [] });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: "Missing x-line-signature header",
    });
  });

  test("ReactNJob LINE notification routes fail safely without external credentials", async () => {
    const jobNotify = await api
      .post("/api/reactnjob/notify/line/job-application")
      .send({ fullName: "Test Applicant", positionApplied: "Test Role" });
    expect(jobNotify.status).toBe(200);
    expect(jobNotify.body).toEqual({
      ok: false,
      skipped: true,
      error: "Missing REACTNJOB_LINE_CHANNEL_ACCESS_TOKEN or LINE_CHANNEL_ACCESS_TOKEN",
    });

    const cvNotify = await api
      .post("/api/reactnjob/line/notify")
      .send({ applicantName: "Test Applicant" });
    expect(cvNotify.status).toBe(200);
    expect(cvNotify.body).toEqual({
      ok: false,
      skipped: true,
      error: "Missing REACTNJOB_LINE_CHANNEL_ACCESS_TOKEN or LINE_CHANNEL_ACCESS_TOKEN",
    });
  });

  test("ReactNJob upload and application routes keep baseline validation behavior", async () => {
    const missingCv = await api.post("/api/reactnjob/apply/cv").field("source", "test");
    expect(missingCv.status).toBe(400);
    expect(missingCv.body).toEqual({ ok: false, error: "Missing CV file" });

    const wrongType = await api
      .post("/api/reactnjob/apply/cv")
      .attach("cv", Buffer.from("not a pdf"), {
        filename: "resume.txt",
        contentType: "text/plain",
      });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body).toEqual({ ok: false, error: "CV must be a PDF" });

    const invalidPayload = await api
      .post("/api/reactnjob/submit-application")
      .field("payload", "{");
    expect(invalidPayload.status).toBe(400);
    expect(invalidPayload.body).toEqual({ ok: false, error: "Invalid payload JSON" });

    const resume = await api.post("/api/reactnjob/resume").send({});
    expect(resume.status).toBe(400);
    expect(resume.body).toEqual({ ok: false, error: "Missing resume attachment data" });
  });
});
