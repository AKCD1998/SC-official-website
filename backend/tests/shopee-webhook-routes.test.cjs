process.env.SEAMLESS_DB_SCHEMA = "clasp_scx_seamless";

const express = require("express");
const request = require("supertest");

const mockVerifyOidc = jest.fn(async () => ({ email_verified: true }));
const mockScheduleSync = jest.fn(async () => ({}));

jest.mock("../src/modules/seamless/services/googlePubsubOidcVerifier", () => ({
  verifyGooglePubsubOidcRequest: (...args) => mockVerifyOidc(...args),
}));

jest.mock("../src/modules/seamless/services/shopeeGmailPushSyncScheduler", () => ({
  scheduleShopeeGmailPushSync: (...args) => mockScheduleSync(...args),
}));

const { errorHandler } = require("../src/modules/seamless/middleware/errorHandler");

function buildApp() {
  const routes = require("../src/modules/seamless/routes/shopeeWebhookRoutes");
  const app = express();
  app.use(express.json());
  app.use("/api/shopee-webhooks", routes);
  app.use(errorHandler);
  return app;
}

function envelope(emailAddress = "admin@scgroup1989.com", historyId = "12345") {
  return {
    message: {
      data: Buffer.from(JSON.stringify({ emailAddress, historyId })).toString("base64"),
      messageId: "pubsub-msg-1",
      publishTime: "2026-09-01T00:00:00.000Z",
    },
    subscription: "projects/example/subscriptions/shopee-admin-push",
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockVerifyOidc.mockResolvedValue({ email_verified: true });
  mockScheduleSync.mockResolvedValue({});
  process.env.SEAMLESS_SHOPEE_GMAIL_PUSH_AUDIENCE =
    "https://sc-official-website.onrender.com/api/shopee-webhooks/gmail";
  process.env.SEAMLESS_SHOPEE_GMAIL_PUSH_SERVICE_ACCOUNT_EMAIL =
    "pubsub-push-shopee@example-project.iam.gserviceaccount.com";
});

afterAll(() => {
  delete process.env.SEAMLESS_DB_SCHEMA;
  delete process.env.SEAMLESS_SHOPEE_GMAIL_PUSH_AUDIENCE;
  delete process.env.SEAMLESS_SHOPEE_GMAIL_PUSH_SERVICE_ACCOUNT_EMAIL;
});

test.each([
  ["admin@scgroup1989.com", "sc-drug-store"],
  ["scgroup1989.glucooneshop@gmail.com", "dr-morepen"],
])("acknowledges an authenticated %s notification and schedules the pinned shop", async (mailbox, shopCode) => {
  const response = await request(buildApp())
    .post("/api/shopee-webhooks/gmail")
    .set("Authorization", "Bearer signed-google-id-token")
    .send(envelope(mailbox));

  expect(response.status).toBe(204);
  await new Promise((resolve) => setImmediate(resolve));
  expect(mockVerifyOidc).toHaveBeenCalledWith(
    expect.objectContaining({ body: expect.any(Object) }),
    {
      audience: "https://sc-official-website.onrender.com/api/shopee-webhooks/gmail",
      serviceAccountEmail: "pubsub-push-shopee@example-project.iam.gserviceaccount.com",
    },
  );
  expect(mockScheduleSync).toHaveBeenCalledWith({
    historyId: "12345",
    messageId: "pubsub-msg-1",
    shopCode,
  });
});

test("does not acknowledge when OIDC verification fails", async () => {
  const error = new Error("Invalid Pub/Sub OIDC bearer token.");
  error.statusCode = 401;
  error.code = "UNAUTHORIZED";
  mockVerifyOidc.mockRejectedValueOnce(error);

  const response = await request(buildApp())
    .post("/api/shopee-webhooks/gmail")
    .set("Authorization", "Bearer invalid")
    .send(envelope());

  expect(response.status).toBe(401);
  expect(mockScheduleSync).not.toHaveBeenCalled();
});

test.each([
  [{ message: {} }],
  [{ message: { data: "not base64!" } }],
  [envelope("admin@scgroup1989.com", "not-a-history-id")],
])("rejects a malformed Pub/Sub envelope before scheduling", async (body) => {
  const response = await request(buildApp())
    .post("/api/shopee-webhooks/gmail")
    .set("Authorization", "Bearer signed-google-id-token")
    .send(body);

  expect(response.status).toBe(400);
  expect(mockScheduleSync).not.toHaveBeenCalled();
});

test("acknowledges but ignores an authenticated notification for an unconfigured mailbox", async () => {
  const response = await request(buildApp())
    .post("/api/shopee-webhooks/gmail")
    .set("Authorization", "Bearer signed-google-id-token")
    .send(envelope("other@example.com"));

  expect(response.status).toBe(204);
  await new Promise((resolve) => setImmediate(resolve));
  expect(mockScheduleSync).not.toHaveBeenCalled();
});

test("acknowledges without waiting for the background sync", async () => {
  mockScheduleSync.mockReturnValueOnce(new Promise(() => {}));

  const response = await request(buildApp())
    .post("/api/shopee-webhooks/gmail")
    .set("Authorization", "Bearer signed-google-id-token")
    .send(envelope());

  expect(response.status).toBe(204);
});
