const express = require("express");
const request = require("supertest");
const workbookRoutes = require("../src/modules/seamless/routes/workbookRoutes");
const { errorHandler } = require("../src/modules/seamless/middleware/errorHandler");

describe("seamless appAuth middleware", () => {
  function buildApp() {
    // Re-require fresh each time so env var changes between tests actually take effect —
    // config.js/appAuth.js read process.env live on every call, no module-level caching.
    delete require.cache[require.resolve("../src/modules/seamless/middleware/appAuth")];
    const { appAuth } = require("../src/modules/seamless/middleware/appAuth");

    const app = express();
    app.use(appAuth);
    app.get("/protected", (req, res) => res.json({ ok: true }));
    return app;
  }

  function buildWorkbookApp() {
    const app = express();
    app.use("/api/workbooks", workbookRoutes);
    app.use(errorHandler);
    return app;
  }

  afterEach(() => {
    delete process.env.SEAMLESS_APP_BASIC_USER;
    delete process.env.SEAMLESS_APP_BASIC_PASSWORD;
    delete process.env.SEAMLESS_INTERNAL_API_TOKEN;
    delete process.env.INTERNAL_API_TOKEN;
  });

  test("when SEAMLESS_APP_BASIC_USER/PASSWORD are unset, the route stays open (default-off)", async () => {
    const app = buildApp();
    const response = await request(app).get("/protected");
    expect(response.status).toBe(200);
  });

  test("with credentials configured, requests without any auth are rejected with WWW-Authenticate", async () => {
    process.env.SEAMLESS_APP_BASIC_USER = "admin";
    process.env.SEAMLESS_APP_BASIC_PASSWORD = "secret";
    const app = buildApp();

    const response = await request(app).get("/protected");
    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toMatch(/Basic/);
  });

  test("correct Basic credentials pass auth", async () => {
    process.env.SEAMLESS_APP_BASIC_USER = "admin";
    process.env.SEAMLESS_APP_BASIC_PASSWORD = "secret";
    const app = buildApp();

    const response = await request(app).get("/protected").auth("admin", "secret");
    expect(response.status).toBe(200);
  });

  test("incorrect Basic credentials are rejected", async () => {
    process.env.SEAMLESS_APP_BASIC_USER = "admin";
    process.env.SEAMLESS_APP_BASIC_PASSWORD = "secret";
    const app = buildApp();

    const response = await request(app).get("/protected").auth("admin", "wrong");
    expect(response.status).toBe(401);
  });

  test("a valid Bearer SEAMLESS_INTERNAL_API_TOKEN also passes auth (print-agent keeps working)", async () => {
    process.env.SEAMLESS_APP_BASIC_USER = "admin";
    process.env.SEAMLESS_APP_BASIC_PASSWORD = "secret";
    process.env.SEAMLESS_INTERNAL_API_TOKEN = "agent-token";
    const app = buildApp();

    const response = await request(app)
      .get("/protected")
      .set("Authorization", "Bearer agent-token");
    expect(response.status).toBe(200);
  });

  test("POST /api/workbooks/process rejects requests without credentials before upload handling", async () => {
    process.env.SEAMLESS_APP_BASIC_USER = "admin";
    process.env.SEAMLESS_APP_BASIC_PASSWORD = "secret";
    const app = buildWorkbookApp();

    const response = await request(app).post("/api/workbooks/process");

    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toMatch(/Basic/);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  test("POST /api/workbooks/process accepts correct Basic credentials", async () => {
    process.env.SEAMLESS_APP_BASIC_USER = "admin";
    process.env.SEAMLESS_APP_BASIC_PASSWORD = "secret";
    const app = buildWorkbookApp();

    const response = await request(app)
      .post("/api/workbooks/process")
      .auth("admin", "secret");

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe("At least one workbook file is required.");
  });

  test("POST /api/workbooks/process accepts the internal Bearer credential", async () => {
    process.env.SEAMLESS_APP_BASIC_USER = "admin";
    process.env.SEAMLESS_APP_BASIC_PASSWORD = "secret";
    process.env.SEAMLESS_INTERNAL_API_TOKEN = "agent-token";
    const app = buildWorkbookApp();

    const response = await request(app)
      .post("/api/workbooks/process")
      .set("Authorization", "Bearer agent-token");

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe("At least one workbook file is required.");
  });
});
