const express = require("express");
const request = require("supertest");

jest.mock("@sendgrid/mail", () => ({
  setApiKey: jest.fn(),
  send: jest.fn(() => Promise.resolve([{ statusCode: 202 }])),
}));

const state = {};

function resetState() {
  state.customers = [
    {
      id: "cust-1",
      phone: "0812345678",
      full_name: "Alice Pharmacist",
      email: "alice@example.com",
      tier: "bronze",
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];
  state.staffDevices = [];
  state.customerEmailVerifications = [];
  state.transactions = [];
  state.pointLedger = [];
  state.redemptions = [];
  state.promotions = [];
}

resetState();

async function mockQuery(sql, params = []) {
  const text = String(sql).replace(/\s+/g, " ").trim();

  if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
    return { rows: [], rowCount: 0 };
  }

  if (text.includes("SELECT id, device_id, device_name FROM staff_devices")) {
    const found = state.staffDevices.find((item) => item.token_hash === params[0] && !item.revoked_at);
    return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
  }

  if (text.startsWith("UPDATE staff_devices SET last_seen_at=NOW()")) {
    return { rows: [], rowCount: 1 };
  }

  if (text.startsWith("SELECT id FROM staff_devices WHERE device_id=")) {
    const found = state.staffDevices.find((item) => item.device_id === params[0]);
    return { rows: found ? [{ id: found.id }] : [], rowCount: found ? 1 : 0 };
  }

  if (text.startsWith("INSERT INTO staff_devices")) {
    state.staffDevices.push({
      id: params[0],
      device_id: params[1],
      device_name: params[2],
      token_hash: params[3],
      revoked_at: null,
    });
    return { rows: [], rowCount: 1 };
  }

  if (text.startsWith("UPDATE staff_devices SET device_name=")) {
    const found = state.staffDevices.find((item) => item.id === params[0]);
    Object.assign(found, { device_name: params[1], token_hash: params[2], revoked_at: null });
    return { rows: [], rowCount: 1 };
  }

  if (text.startsWith("SELECT id FROM customers WHERE lower(email)=lower(")) {
    const found = state.customers.find((item) => item.email?.toLowerCase() === String(params[0]).toLowerCase());
    return { rows: found ? [{ id: found.id }] : [], rowCount: found ? 1 : 0 };
  }

  if (text.startsWith("INSERT INTO customer_email_verifications")) {
    state.customerEmailVerifications.push({
      id: params[0],
      customer_email: params[1],
      otp_hash: params[2],
      expires_at: params[3],
      used_at: null,
      attempt_count: 0,
    });
    return { rows: [], rowCount: 1 };
  }

  if (text.startsWith("SELECT * FROM customers WHERE id=") || text.startsWith("SELECT id FROM customers WHERE id=")) {
    const found = state.customers.find((item) => item.id === params[0]);
    return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
  }

  if (text.startsWith("SELECT COALESCE(SUM(amount), 0) AS earned")) {
    const earned = state.pointLedger
      .filter((item) => item.customer_id === params[0] && item.amount > 0)
      .reduce((sum, item) => sum + item.amount, 0);
    return { rows: [{ earned }], rowCount: 1 };
  }

  if (text.startsWith("UPDATE customers SET tier=")) {
    const customer = state.customers.find((item) => item.id === params[0]);
    customer.tier = params[1];
    return { rows: [], rowCount: 1 };
  }

  if (text.startsWith("SELECT COALESCE(SUM(amount), 0) AS balance")) {
    const balance = state.pointLedger
      .filter((item) => item.customer_id === params[0])
      .reduce((sum, item) => sum + item.amount, 0);
    return { rows: [{ balance }], rowCount: 1 };
  }

  if (text.startsWith("SELECT id, name, type, value, condition_json")) {
    return { rows: state.promotions, rowCount: state.promotions.length };
  }

  if (text.startsWith("INSERT INTO transactions")) {
    state.transactions.push({
      id: params[0],
      customer_id: params[1],
      total_amount: Number(params[2]),
      point_earned: Number(params[3]),
      source: params[4] || "manual",
      pos_ref_id: params[5],
      created_at: params[6] || new Date().toISOString(),
    });
    return { rows: [], rowCount: 1 };
  }

  if (text.startsWith("INSERT INTO point_ledger")) {
    state.pointLedger.push({
      id: params[0],
      customer_id: params[1],
      amount: Number(params[2]),
      reference_id: params[3],
      note: params[4],
      created_by: params[5],
      created_at: params[6] || new Date().toISOString(),
    });
    return { rows: [], rowCount: 1 };
  }

  if (text.startsWith("SELECT id FROM transactions WHERE pos_ref_id=")) {
    const found = state.transactions.find((item) => item.pos_ref_id === params[0]);
    return { rows: found ? [{ id: found.id }] : [], rowCount: found ? 1 : 0 };
  }

  if (text.startsWith("SELECT id FROM customers WHERE phone=")) {
    const found = state.customers.find((item) => item.phone === params[0]);
    return { rows: found ? [{ id: found.id }] : [], rowCount: found ? 1 : 0 };
  }

  if (text.startsWith("SELECT id, phone, full_name, email, tier, is_active")) {
    const found = state.customers.find((item) => item.phone === params[0]);
    return {
      rows: found
        ? [
            {
              id: found.id,
              phone: found.phone,
              full_name: found.full_name,
              email: found.email,
              tier: found.tier,
              is_active: found.is_active,
              created_at: found.created_at,
              updated_at: found.updated_at,
            },
          ]
        : [],
      rowCount: found ? 1 : 0,
    };
  }

  throw new Error(`Unhandled SQL in test: ${text}`);
}

jest.mock("../db", () => ({
  query: jest.fn((sql, params) => mockQuery(sql, params)),
  connect: jest.fn(async () => ({
    query: jest.fn((sql, params) => mockQuery(sql, params)),
    release: jest.fn(),
  })),
}));

const sgMail = require("@sendgrid/mail");
const sccrmRouter = require("../routes/sccrm");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/sccrm", sccrmRouter);
  return app;
}

beforeEach(() => {
  resetState();
  process.env.SENDGRID_API_KEY = "SG.test";
  process.env.MAIL_USER = "sender@example.com";
  process.env.SCCRM_ACCESS_JWT_SECRET = "sccrm-access-secret";
  process.env.SCCRM_REFRESH_TOKEN_SECRET = "sccrm-refresh-secret";
  process.env.SCCRM_STAFF_PIN = "654321";
  delete process.env.SCCRM_ALLOWED_STAFF_DEVICE_NAMES;
  sgMail.send.mockClear();
});

afterAll(() => {
  delete process.env.SENDGRID_API_KEY;
  delete process.env.MAIL_USER;
  delete process.env.SCCRM_ACCESS_JWT_SECRET;
  delete process.env.SCCRM_REFRESH_TOKEN_SECRET;
  delete process.env.SCCRM_STAFF_PIN;
  delete process.env.SCCRM_ALLOWED_STAFF_DEVICE_NAMES;
});

describe("SCCRM routes", () => {
  test("POST /auth/staff-device exchanges PIN for a staff token", async () => {
    const response = await request(createApp()).post("/api/sccrm/auth/staff-device").send({
      deviceId: "device-1",
      deviceName: "Counter Tablet",
      pin: "654321",
    });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(typeof response.body.staffToken).toBe("string");
    expect(state.staffDevices).toHaveLength(1);
  });

  test("POST /auth/register send-otp stores verification request and sends email", async () => {
    const response = await request(createApp()).post("/api/sccrm/auth/register").send({
      step: "send-otp",
      email: "new@example.com",
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(state.customerEmailVerifications).toHaveLength(1);
    expect(sgMail.send).toHaveBeenCalledTimes(1);
  });

  test("POST /points/earn creates transaction and ledger entries", async () => {
    const staffBootstrap = await request(createApp()).post("/api/sccrm/auth/staff-device").send({
      deviceId: "device-1",
      deviceName: "Counter Tablet",
      pin: "654321",
    });

    const response = await request(createApp())
      .post("/api/sccrm/points/earn")
      .set("Authorization", `Bearer ${staffBootstrap.body.staffToken}`)
      .send({
        customer_id: "cust-1",
        amount_thb: 250,
        reference_id: "manual-1",
      });

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
    expect(response.body.pointsAwarded).toBe(25);
    expect(state.transactions).toHaveLength(1);
    expect(state.pointLedger).toHaveLength(1);
    expect(response.body.balance).toBe(25);
  });

  test("POST /import/pos skips duplicate refs and counts unmatched customers", async () => {
    const staffBootstrap = await request(createApp()).post("/api/sccrm/auth/staff-device").send({
      deviceId: "device-1",
      deviceName: "Counter Tablet",
      pin: "654321",
    });

    state.transactions.push({
      id: "txn-existing",
      pos_ref_id: "dup-1",
      customer_id: "cust-1",
      total_amount: 100,
      point_earned: 10,
      source: "pos_import",
      created_at: "2026-05-12T00:00:00.000Z",
    });

    const response = await request(createApp())
      .post("/api/sccrm/import/pos")
      .set("Authorization", `Bearer ${staffBootstrap.body.staffToken}`)
      .send([
        {
          pos_ref_id: "dup-1",
          phone: "0812345678",
          total_amount: 100,
          created_at: "2026-05-12T00:00:00.000Z",
          source: "pos_import",
        },
        {
          pos_ref_id: "new-1",
          phone: "0899999999",
          total_amount: 90,
          created_at: "2026-05-12T01:00:00.000Z",
          source: "pos_import",
        },
      ]);

    expect(response.status).toBe(200);
    expect(response.body.summary).toEqual({
      imported: 1,
      skipped_duplicates: 1,
      unmatched_customers: 1,
      errors: [],
    });
  });
});
