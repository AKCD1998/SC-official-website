const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const { Client } = require("pg");
const { provisionCrmCounter } = require("../scripts/provision-crm-counter.cjs");

let mockClient;
let mockTransactionNumber = 0;
const mockPool = {
  query: (...args) => mockClient.query(...args),
  async connect() {
    const savepoint = `crm_counter_route_${++mockTransactionNumber}`;
    return {
      async query(sql, params) {
        if (sql === "BEGIN") return mockClient.query(`SAVEPOINT ${savepoint}`);
        if (sql === "COMMIT") return mockClient.query(`RELEASE SAVEPOINT ${savepoint}`);
        if (sql === "ROLLBACK") return mockClient.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        return mockClient.query(sql, params);
      },
      release() {},
    };
  },
};
jest.mock("../db", () => mockPool);
jest.mock("@sendgrid/mail", () => ({ setApiKey: jest.fn(), send: jest.fn() }));

const run = process.env.CRM_COUNTER_POSTGRES_SMOKE === "1";
const describePostgres = run ? describe : describe.skip;
const sql = fs.readFileSync(path.join(__dirname,
  "../migrations/202610200001_crm_counter_bootstrap.sql"), "utf8");

describePostgres("CRM counter bootstrap with PostgreSQL and real route handlers", () => {
  let app;
  let staffToken;
  let memberId;
  const priorPin = process.env.SCCRM_STAFF_PIN;
  const priorNames = process.env.SCCRM_ALLOWED_STAFF_DEVICE_NAMES;
  const priorRefreshSecret = process.env.SCCRM_REFRESH_TOKEN_SECRET;
  const member = {
    name: "Synthetic counter fixture",
    phone: "0990000000",
    email: "crm-counter-fixture@example.invalid",
    dob: "1990-01-01",
    sex: "female",
    consents: { pdpa_general: true, pdpa_health: true },
  };

  beforeAll(async () => {
    const raw = process.env.SC_OFFICIAL_SUPABASE_DATABASE_URL;
    if (!raw || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(raw).hostname)) {
      throw new Error("CRM integration tests require an explicitly enabled local ephemeral database");
    }
    mockClient = new Client({ connectionString: raw, ssl: false });
    await mockClient.connect();
    const before = await mockClient.query("SELECT to_regclass('public.users') IS NULL AS empty");
    if (!before.rows[0].empty) throw new Error("CRM integration database must start without CRM tables");
    const dry = await provisionCrmCounter(mockClient);
    expect(dry.status).toBe("dry-run-rolled-back");
    const after = await mockClient.query("SELECT to_regclass('public.users') IS NULL AS empty");
    expect(after.rows[0].empty).toBe(true);

    await mockClient.query("BEGIN");
    await mockClient.query(sql);
    process.env.SCCRM_STAFF_PIN = "synthetic-fixture-pin";
    process.env.SCCRM_REFRESH_TOKEN_SECRET = "synthetic-fixture-hmac-secret";
    process.env.SCCRM_ALLOWED_STAFF_DEVICE_NAMES = "synthetic-counter-fixture";
    app = express();
    app.use(express.json());
    app.use("/api/sccrm", require("../routes/sccrm"));
    app.use("/api/crm", require("../routes/crmMembers"));
  });

  afterAll(async () => {
    if (mockClient) {
      await mockClient.query("ROLLBACK");
      await mockClient.end();
    }
    if (priorPin === undefined) delete process.env.SCCRM_STAFF_PIN;
    else process.env.SCCRM_STAFF_PIN = priorPin;
    if (priorNames === undefined) delete process.env.SCCRM_ALLOWED_STAFF_DEVICE_NAMES;
    else process.env.SCCRM_ALLOWED_STAFF_DEVICE_NAMES = priorNames;
    if (priorRefreshSecret === undefined) delete process.env.SCCRM_REFRESH_TOKEN_SECRET;
    else process.env.SCCRM_REFRESH_TOKEN_SECRET = priorRefreshSecret;
  });

  test("rejects anonymous requests and a Sync key header without a staff session", async () => {
    const anonymous = await request(app).post("/api/crm/members").send(member);
    const sync = await request(app).post("/api/crm/members").set("x-pos-api-key", "synthetic-sync-key").send(member);
    expect(anonymous.status).toBe(401);
    expect(sync.status).toBe(401);
  });

  test("rejects a wrong staff PIN before creating a device", async () => {
    const response = await request(app).post("/api/sccrm/auth/staff-device").send({
      deviceId: "synthetic-fixture-device", deviceName: "synthetic-counter-fixture", pin: "incorrect",
    });
    expect(response.status).toBe(401);
    const count = await mockClient.query("SELECT count(*)::int AS count FROM public.staff_devices");
    expect(count.rows[0].count).toBe(0);
  });

  test("authenticates the existing staff-device contract and registers profile/consent atomically", async () => {
    const login = await request(app).post("/api/sccrm/auth/staff-device").send({
      deviceId: "synthetic-fixture-device", deviceName: "synthetic-counter-fixture", pin: "synthetic-fixture-pin",
    });
    expect(login.status).toBe(200);
    expect(typeof login.body.staffToken === "string").toBe(true);
    staffToken = login.body.staffToken;
    const registration = await request(app).post("/api/crm/members")
      .set("Authorization", `Bearer ${staffToken}`).send(member);
    expect(registration.status).toBe(201);
    expect(registration.body.ok === true).toBe(true);
    memberId = registration.body.data.id;
    const counts = await mockClient.query(`SELECT
      (SELECT count(*)::int FROM public.users) AS users,
      (SELECT count(*)::int FROM public.member_profiles) AS profiles,
      (SELECT count(*)::int FROM public.crm_member_consents WHERE pdpa_general AND pdpa_health) AS consents`);
    expect(counts.rows[0]).toEqual({ users: 1, profiles: 1, consents: 1 });
  });

  test("rejects duplicate registration and preserves the original profile", async () => {
    const response = await request(app).post("/api/crm/members")
      .set("Authorization", `Bearer ${staffToken}`).send(member);
    expect(response.status).toBe(409);
    const count = await mockClient.query("SELECT count(*)::int AS count FROM public.users");
    expect(count.rows[0].count).toBe(1);
  });

  test("supports the existing optional health-record upsert with synthetic data", async () => {
    const first = await request(app).put(`/api/crm/members/${memberId}/health`)
      .set("Authorization", `Bearer ${staffToken}`).send({ hasDiabetes: false });
    const second = await request(app).put(`/api/crm/members/${memberId}/health`)
      .set("Authorization", `Bearer ${staffToken}`).send({ hasDiabetes: true });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const count = await mockClient.query("SELECT count(*)::int AS count FROM public.crm_member_health_records");
    expect(count.rows[0].count).toBe(1);
  });

  test("reapplying setup preserves fixture rows and the single ledger entry", async () => {
    await mockClient.query(sql);
    const counts = await mockClient.query(`SELECT
      (SELECT count(*)::int FROM public.users) AS users,
      (SELECT count(*)::int FROM public.crm_counter_schema_migrations) AS ledger`);
    expect(counts.rows[0]).toEqual({ users: 1, ledger: 1 });
  });

  test("RLS denies a non-owner role even when it receives SELECT permission", async () => {
    await mockClient.query("CREATE ROLE crm_counter_reader_ci NOLOGIN");
    await mockClient.query("GRANT USAGE ON SCHEMA public TO crm_counter_reader_ci");
    await mockClient.query("GRANT SELECT ON public.users TO crm_counter_reader_ci");
    await mockClient.query("SET LOCAL ROLE crm_counter_reader_ci");
    try {
      const rows = await mockClient.query("SELECT count(*)::int AS count FROM public.users");
      expect(rows.rows[0].count).toBe(0);
    } finally {
      await mockClient.query("RESET ROLE");
    }
    const security = await mockClient.query(`SELECT count(*)::int AS count
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND c.relrowsecurity`,
    [["users", "branches", "staff_devices", "member_profiles", "crm_member_consents", "crm_member_health_records", "crm_counter_schema_migrations"]]);
    expect(security.rows[0].count).toBe(7);
  });
});
