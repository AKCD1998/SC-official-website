const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const { Pool } = require("pg");
const { createPublicMemberRegistration } = require("../routes/publicMemberRegistration");

const run = process.env.CRM_PUBLIC_POSTGRES_SMOKE === "1";
const describePostgres = run ? describe : describe.skip;
const fixture = { firstName: "Synthetic", lastName: "Registration", phone: "0990000001", consent: true };

describePostgres("public registration with disposable PostgreSQL", () => {
  let pool;
  let app;
  let log;

  beforeAll(async () => {
    const raw = process.env.SCCRM_PUBLIC_TEST_DATABASE_URL;
    const url = new URL(raw || "http://invalid");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || !url.pathname.startsWith("/crm_public_registration_test_")) {
      throw new Error("Use a fresh local crm_public_registration_test_* database only");
    }
    pool = new Pool({ connectionString: raw, ssl: false });
    const before = await pool.query("SELECT to_regclass('public.users') IS NULL AS empty");
    if (!before.rows[0].empty) throw new Error("The disposable public-registration database must be empty");
    const schema = fs.readFileSync(path.join(__dirname, "../migrations/202610200001_crm_counter_bootstrap.sql"), "utf8");
    await pool.query(schema);
    app = express();
    app.use("/join", createPublicMemberRegistration({ pool, maxRequests: 1000 }));
    log = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterAll(async () => {
    if (log) log.mockRestore();
    if (pool) await pool.end();
  });

  const send = (body) => request(app).post("/join/submit").send(body);

  test("saves identity, member profile and exact consent together without a password, DOB or staff token", async () => {
    const response = await send({ ...fixture, is_verified: true, tier: "gold" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, message: "รับข้อมูลเรียบร้อยแล้ว" });
    const { rows } = await pool.query(`SELECT u.full_name, u.email, u.dob, u.password_hash,
      u.is_verified, u.verified_at, m.member_code, m.tier, c.consent_version,
      c.pdpa_general, c.pdpa_health, c.marketing_email, c.marketing_sms, c.recorded_by_device_id
      FROM users u JOIN member_profiles m ON m.user_id=u.id
      JOIN crm_member_consents c ON c.user_id=u.id WHERE u.phone_number=$1`, [fixture.phone]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      full_name: "Synthetic Registration", email: null, dob: null, password_hash: null,
      is_verified: false, verified_at: null, tier: "bronze", consent_version: "qr-v1.0",
      pdpa_general: true, pdpa_health: false, marketing_email: false, marketing_sms: false, recorded_by_device_id: null,
    }));
    expect(rows[0].member_code).toMatch(/^SCM-[A-F0-9]{8}$/);
  });

  test("duplicate submissions reveal no membership data and never overwrite another customer's name", async () => {
    const duplicate = await send({ ...fixture, firstName: "Different", lastName: "Person", phone: "+66 99 000 0001" });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toEqual({ ok: true, message: "รับข้อมูลเรียบร้อยแล้ว" });
    const { rows } = await pool.query(`SELECT u.full_name, count(c.id)::int AS consents
      FROM users u JOIN crm_member_consents c ON c.user_id=u.id
      WHERE u.phone_number=$1 GROUP BY u.full_name`, [fixture.phone]);
    expect(rows).toEqual([{ full_name: "Synthetic Registration", consents: 1 }]);
  });

  test("simultaneous retries create exactly one member and one consent", async () => {
    const body = { ...fixture, phone: "0990000002" };
    const responses = await Promise.all(Array.from({ length: 4 }, () => send(body)));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const { rows } = await pool.query(`SELECT count(*)::int AS count
      FROM users u JOIN member_profiles m ON m.user_id=u.id
      JOIN crm_member_consents c ON c.user_id=u.id WHERE u.phone_number=$1`, [body.phone]);
    expect(rows[0].count).toBe(1);
  });

  test("rolls back the identity and profile if storing consent fails", async () => {
    await pool.query(`ALTER TABLE crm_member_consents ADD CONSTRAINT fixture_refuse_public
      CHECK (consent_version <> 'qr-v1.0') NOT VALID`);
    try {
      const response = await send({ ...fixture, phone: "0990000003" });
      expect(response.status).toBe(503);
      const { rows } = await pool.query("SELECT count(*)::int AS count FROM users WHERE phone_number=$1", ["0990000003"]);
      expect(rows[0].count).toBe(0);
      const orphan = await pool.query("SELECT count(*)::int AS count FROM member_profiles m LEFT JOIN users u ON u.id=m.user_id WHERE u.id IS NULL");
      expect(orphan.rows[0].count).toBe(0);
    } finally {
      await pool.query("ALTER TABLE crm_member_consents DROP CONSTRAINT fixture_refuse_public");
    }
  });
});
