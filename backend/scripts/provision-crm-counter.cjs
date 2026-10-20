"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const filename = "202610200001_crm_counter_bootstrap.sql";
const tables = ["users", "branches", "staff_devices", "member_profiles",
  "crm_member_consents", "crm_member_health_records"];

async function provisionCrmCounter(client, { apply = false } = {}) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SELECT pg_advisory_xact_lock(20261020, 65)");
    const existing = await client.query(
      "SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[])",
      [tables],
    );
    const ledger = await client.query("SELECT to_regclass('public.crm_counter_schema_migrations') IS NOT NULL AS present");
    let alreadyApplied = false;
    if (ledger.rows[0].present) {
      const row = await client.query("SELECT count(*)::int AS count FROM public.crm_counter_schema_migrations WHERE filename=$1", [filename]);
      alreadyApplied = row.rows[0].count === 1;
    }
    if (existing.rows[0].count !== 0 && !(alreadyApplied && existing.rows[0].count === tables.length)) {
      throw new Error("CRM_EXISTING_SCHEMA_REQUIRES_REVIEW");
    }
    await client.query(fs.readFileSync(path.join(__dirname, "../migrations", filename), "utf8"));
    const privacy = await client.query(
      `SELECT count(*)::int AS count, bool_and(c.relrowsecurity) AS rls_enabled
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND c.relkind='r'`,
      [[...tables, "crm_counter_schema_migrations"]],
    );
    if (privacy.rows[0].count !== 7 || !privacy.rows[0].rls_enabled) throw new Error("CRM_SCHEMA_PRIVACY_CHECK_FAILED");
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    return { status: apply ? "applied" : "dry-run-rolled-back", filename,
      tablesVerified: tables.length, rowLevelSecurity: true, alreadyApplied,
      unrelatedMigrationsRun: false, businessRowsInserted: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== "--apply")) throw new Error("MODE_NOT_ALLOWED");
  const raw = process.env.SC_OFFICIAL_SUPABASE_DATABASE_URL;
  if (!raw) throw new Error("CRM_DATABASE_CONFIGURATION_MISSING");
  const url = new URL(raw);
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") throw new Error("CRM_DATABASE_PROTOCOL_REFUSED");
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) {
    if (url.searchParams.has(key)) throw new Error("CRM_TLS_URL_PARAMETERS_REQUIRE_REVIEW");
  }
  const caPath = process.env.CRM_BOOTSTRAP_TLS_CA_FILE;
  const client = new Client({ connectionString: url.href,
    ssl: { rejectUnauthorized: true, ...(caPath ? { ca: fs.readFileSync(caPath, "utf8") } : {}) },
    connectionTimeoutMillis: 10000, query_timeout: 15000 });
  client.on("error", () => {});
  try {
    await client.connect();
    console.log(JSON.stringify(await provisionCrmCounter(client, { apply: process.argv.includes("--apply") })));
  } finally {
    await client.end();
  }
}

module.exports = { provisionCrmCounter, tables, filename };
if (require.main === module) main().catch(() => {
  console.error(JSON.stringify({ status: "stopped", code: "CRM_BOOTSTRAP_FAILED", detailsWithheld: true }));
  process.exitCode = 1;
});
