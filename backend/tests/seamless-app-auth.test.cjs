const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const workbookRoutes = require("../src/modules/seamless/routes/workbookRoutes");
const sessionRoutes = require("../src/modules/seamless/routes/sessionRoutes");
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

  function buildSessionApp() {
    delete require.cache[require.resolve("../src/modules/seamless/middleware/appAuth")];
    const { appAuth } = require("../src/modules/seamless/middleware/appAuth");

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api/app/session", sessionRoutes);
    app.get("/protected", appAuth, (req, res) => res.json({ ok: true }));
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

  test("GET /api/app/session reports unauthenticated with no cookie", async () => {
    process.env.SEAMLESS_APP_BASIC_USER = "admin";
    process.env.SEAMLESS_APP_BASIC_PASSWORD = "secret";
    const app = buildSessionApp();

    const response = await request(app).get("/api/app/session");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ authenticated: false });
  });

  test("POST /api/app/session/login rejects incorrect credentials", async () => {
    process.env.SEAMLESS_APP_BASIC_USER = "admin";
    process.env.SEAMLESS_APP_BASIC_PASSWORD = "secret";
    const app = buildSessionApp();

    const response = await request(app)
      .post("/api/app/session/login")
      .send({ username: "admin", password: "wrong" });

    expect(response.status).toBe(401);
  });

  test("a session cookie from a successful login lets appAuth-protected routes through", async () => {
    process.env.SEAMLESS_APP_BASIC_USER = "admin";
    process.env.SEAMLESS_APP_BASIC_PASSWORD = "secret";
    const app = buildSessionApp();

    const loginResponse = await request(app)
      .post("/api/app/session/login")
      .send({ username: "admin", password: "secret" });
    expect(loginResponse.status).toBe(200);

    const cookie = loginResponse.headers["set-cookie"];
    expect(cookie).toBeTruthy();

    const protectedResponse = await request(app).get("/protected").set("Cookie", cookie);
    expect(protectedResponse.status).toBe(200);

    const sessionResponse = await request(app).get("/api/app/session").set("Cookie", cookie);
    expect(sessionResponse.body).toEqual({ authenticated: true });
  });

  test("POST /api/app/session/logout clears the cookie so appAuth-protected routes reject again", async () => {
    process.env.SEAMLESS_APP_BASIC_USER = "admin";
    process.env.SEAMLESS_APP_BASIC_PASSWORD = "secret";
    const app = buildSessionApp();

    const loginResponse = await request(app)
      .post("/api/app/session/login")
      .send({ username: "admin", password: "secret" });
    const cookie = loginResponse.headers["set-cookie"];

    const logoutResponse = await request(app).post("/api/app/session/logout").set("Cookie", cookie);
    const clearedCookie = logoutResponse.headers["set-cookie"];

    const protectedResponse = await request(app).get("/protected").set("Cookie", clearedCookie);
    expect(protectedResponse.status).toBe(401);
  });
});
