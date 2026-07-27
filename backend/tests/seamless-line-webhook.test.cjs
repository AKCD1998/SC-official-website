const crypto = require("node:crypto");
const express = require("express");
const request = require("supertest");

process.env.SEAMLESS_LINE_CHANNEL_SECRET = "test-line-channel-secret";
// Point the shared pool somewhere unreachable on purpose — logOperation swallows DB errors
// internally (see db/operationLogRepository.js), so the webhook must still answer 200 even
// when the operation_logs write fails. This must never touch a real database.
process.env.DATABASE_URL = "postgresql://127.0.0.1:1/does-not-exist";

const lineRoutes = require("../src/modules/seamless/routes/lineRoutes");

function sign(body) {
  return crypto.createHmac("sha256", "test-line-channel-secret").update(body).digest("base64");
}

function buildApp() {
  const app = express();
  app.use(
    express.json({
      verify(req, res, buf) {
        req.rawBody = buf;
      },
    }),
  );
  app.use("/api/line", lineRoutes);
  return app;
}

describe("seamless LINE webhook (HMAC-only, no Basic/Bearer)", () => {
  test("rejects an invalid signature", async () => {
    const app = buildApp();
    const response = await request(app)
      .post("/api/line/webhook")
      .set("x-line-signature", "bogus")
      .send({ events: [] });

    expect(response.status).toBe(401);
  });

  test("accepts a valid signature and always answers 200, even when logging to the DB fails", async () => {
    const app = buildApp();
    const payload = { events: [{ type: "join", source: { groupId: "C1234567890abcdef" } }] };
    const bodyString = JSON.stringify(payload);

    const response = await request(app)
      .post("/api/line/webhook")
      .set("x-line-signature", sign(bodyString))
      .set("Content-Type", "application/json")
      .send(bodyString);

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });
});
