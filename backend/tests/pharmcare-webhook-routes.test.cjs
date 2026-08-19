process.env.SEAMLESS_DB_SCHEMA = "clasp_scx_seamless";

const express = require("express");
const request = require("supertest");

let lastSyncCall = null;
jest.mock("../src/modules/seamless/services/pharmcareSyncService", () => ({
  runPharmcareGmailSync: jest.fn(async (adapter, mailboxAccount, options) => {
    lastSyncCall = { mailboxAccount, options };
    return { checkpoint: {}, results: [], runId: "run-1", status: "completed" };
  }),
}));

const { errorHandler } = require("../src/modules/seamless/middleware/errorHandler");

function buildApp() {
  delete require.cache[require.resolve("../src/modules/seamless/routes/pharmcareWebhookRoutes")];
  // eslint-disable-next-line global-require
  const pharmcareWebhookRoutes = require("../src/modules/seamless/routes/pharmcareWebhookRoutes");

  const app = express();
  app.use(express.json());
  app.use("/api/pharmcare-webhooks", pharmcareWebhookRoutes);
  app.use(errorHandler);
  return app;
}

// A minimal but realistic Pub/Sub push envelope — the handler never actually parses this, but
// tests should still send a shape close to reality.
function pubsubEnvelope() {
  return {
    message: {
      data: Buffer.from(JSON.stringify({ emailAddress: "admin@scgroup1989.com", historyId: "12345" })).toString(
        "base64",
      ),
      messageId: "pubsub-msg-1",
      publishTime: "2026-08-19T00:00:00.000Z",
    },
    subscription: "projects/x/subscriptions/pharmcare-gmail-push",
  };
}

beforeEach(() => {
  lastSyncCall = null;
  delete process.env.SEAMLESS_PHARMCARE_GMAIL_WEBHOOK_SECRET;
  delete process.env.SEAMLESS_PHARMCARE_GMAIL_AUTH_MODE;
});

afterAll(() => {
  delete process.env.SEAMLESS_DB_SCHEMA;
});

describe("POST /pharmcare-webhooks/gmail", () => {
  test("rejects a request with no token when a webhook secret is configured", async () => {
    process.env.SEAMLESS_PHARMCARE_GMAIL_WEBHOOK_SECRET = "correct-secret";
    const app = buildApp();

    const response = await request(app).post("/api/pharmcare-webhooks/gmail").send(pubsubEnvelope());

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
    expect(lastSyncCall).toBeNull();
  });

  test("rejects a request with the wrong token", async () => {
    process.env.SEAMLESS_PHARMCARE_GMAIL_WEBHOOK_SECRET = "correct-secret";
    const app = buildApp();

    const response = await request(app)
      .post("/api/pharmcare-webhooks/gmail?token=wrong-secret")
      .send(pubsubEnvelope());

    expect(response.status).toBe(401);
    expect(lastSyncCall).toBeNull();
  });

  test("rejects every request when no webhook secret is configured at all (default-closed)", async () => {
    const app = buildApp();

    const response = await request(app)
      .post("/api/pharmcare-webhooks/gmail?token=anything")
      .send(pubsubEnvelope());

    expect(response.status).toBe(401);
    expect(lastSyncCall).toBeNull();
  });

  test("accepts the correct token, acknowledges immediately, and triggers an incremental sync", async () => {
    process.env.SEAMLESS_PHARMCARE_GMAIL_WEBHOOK_SECRET = "correct-secret";
    process.env.SEAMLESS_PHARMCARE_GMAIL_AUTH_MODE = "oauth_refresh_token";
    process.env.SEAMLESS_PHARMCARE_GMAIL_CLIENT_ID = "client-id";
    process.env.SEAMLESS_PHARMCARE_GMAIL_CLIENT_SECRET = "client-secret";
    process.env.SEAMLESS_PHARMCARE_GMAIL_REFRESH_TOKEN = "refresh-token";
    const app = buildApp();

    const response = await request(app)
      .post("/api/pharmcare-webhooks/gmail?token=correct-secret")
      .send(pubsubEnvelope());

    expect(response.status).toBe(204);
    // The sync runs after the response is sent (fire-and-forget) — give the event loop a tick.
    await new Promise((resolve) => setImmediate(resolve));
    expect(lastSyncCall).not.toBeNull();
    expect(lastSyncCall.mailboxAccount).toBe("admin@scgroup1989.com");
    expect(lastSyncCall.options.runKind).toBe("incremental");

    delete process.env.SEAMLESS_PHARMCARE_GMAIL_CLIENT_ID;
    delete process.env.SEAMLESS_PHARMCARE_GMAIL_CLIENT_SECRET;
    delete process.env.SEAMLESS_PHARMCARE_GMAIL_REFRESH_TOKEN;
  });

  test("accepts the correct token but does not attempt a sync when Gmail is not configured", async () => {
    process.env.SEAMLESS_PHARMCARE_GMAIL_WEBHOOK_SECRET = "correct-secret";
    const app = buildApp();

    const response = await request(app)
      .post("/api/pharmcare-webhooks/gmail?token=correct-secret")
      .send(pubsubEnvelope());

    expect(response.status).toBe(204);
    await new Promise((resolve) => setImmediate(resolve));
    expect(lastSyncCall).toBeNull();
  });
});
