const express = require("express");
const request = require("supertest");
const { createPublicMemberRegistration } = require("../routes/publicMemberRegistration");
const { normalizeThaiPhone, validatePublicRegistration } = require("../lib/publicMemberRegistration");

const valid = { firstName: "ทดสอบ", lastName: "ระบบสมาชิก", phone: "0990000001", consent: true };

function createApp(options = {}) {
  const pool = { connect: jest.fn() };
  const app = express();
  app.use("/join", createPublicMemberRegistration({ pool, ...options }));
  return { app, pool };
}

describe("public QR member registration", () => {
  test.each([
    ["099 000 0001", "0990000001"], ["099-000-0001", "0990000001"],
    ["+66 99 000 0001", "0990000001"], ["0066990000001", "0990000001"],
    ["๐๙๙๐๐๐๐๐๐๑", "0990000001"], ["02 123 4567", "021234567"],
    ["099letters0000001", ""], ["+66990000001+", ""], ["9990000001", ""],
    ["099", ""], [12345, ""], [null, ""],
  ])("normalizes phone %p", (raw, expected) => expect(normalizeThaiPhone(raw)).toBe(expected));

  test.each([
    [{ firstName: "" }, "firstName"], [{ firstName: ["name"] }, "firstName"],
    [{ firstName: "<script>" }, "firstName"], [{ firstName: "x".repeat(101) }, "firstName"],
    [{ lastName: " " }, "lastName"], [{ phone: "invalid" }, "phone"],
    [{ consent: false }, "consent"], [{ consent: "true" }, "consent"],
  ])("rejects invalid input %p before connecting to the database", async (fields, field) => {
    const { app, pool } = createApp();
    const response = await request(app).post("/join/submit").send({ ...valid, ...fields });
    expect(response.status).toBe(400);
    expect(response.body.field).toBe(field);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test("normalizes names without accepting caller-supplied verification or membership fields", () => {
    expect(validatePublicRegistration({ ...valid, firstName: "  ทดสอบ  ", is_verified: true, tier: "gold" }))
      .toEqual({ value: { fullName: "ทดสอบ ระบบสมาชิก", phone: valid.phone } });
  });

  test("serves the customer form and printable QR without staff login", async () => {
    const { app, pool } = createApp();
    const page = await request(app).get("/join");
    expect(page.status).toBe(200);
    expect(page.text).toContain('autocomplete="given-name"');
    expect(page.text).toContain('autocomplete="family-name"');
    expect(page.text).toContain('autocomplete="tel"');
    expect(page.text).toContain('method="post" action="/join/submit"');
    expect(page.text).not.toMatch(/type="password"|localStorage|sessionStorage/);
    expect(page.headers["cache-control"]).toContain("no-store");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect((await request(app).get("/join/qr")).status).toBe(200);
    expect((await request(app).get("/join/assets/qr.svg")).status).toBe(200);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test("rejects cross-origin and non-JSON requests", async () => {
    const { app, pool } = createApp();
    expect((await request(app).post("/join/submit").set("Origin", "https://unrelated.invalid").send(valid)).status).toBe(403);
    expect((await request(app).post("/join/submit").type("form").send(valid)).status).toBe(415);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test("rejects oversized and malformed JSON", async () => {
    const { app, pool } = createApp();
    expect((await request(app).post("/join/submit").send({ ...valid, extra: "x".repeat(5000) })).status).toBe(413);
    expect((await request(app).post("/join/submit").set("Content-Type", "application/json").send("{bad")).status).toBe(400);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test("limits submissions by the last proxy hop, ignores forged leftmost IPs, and resets after the window", async () => {
    let time = 0;
    const { app } = createApp({ now: () => time, maxRequests: 1, windowMs: 1000 });
    const send = (forwarded) => request(app).post("/join/submit").set("X-Forwarded-For", forwarded).send({});
    expect((await send("192.0.2.1, 192.0.2.2")).status).toBe(400);
    const limited = await send("192.0.2.99, 192.0.2.2");
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBe("1");
    expect((await send("192.0.2.3")).status).toBe(400);
    time = 1001;
    expect((await send("192.0.2.2")).status).toBe(400);
  });

  test("returns no success or database details when saving fails", async () => {
    const { app, pool } = createApp();
    pool.connect.mockRejectedValue(new Error("private database connection details"));
    const log = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await request(app).post("/join/submit").send(valid);
      expect(response.status).toBe(503);
      expect(response.body.ok).toBeUndefined();
      expect(JSON.stringify(response.body)).not.toContain("private");
      expect(JSON.stringify(log.mock.calls)).not.toContain("private");
    } finally { log.mockRestore(); }
  });
});
