const fs = require("node:fs");
const path = require("node:path");
const pool = require("../db");
const { getTables } = require("../src/modules/seamless/tables");
const filename = "025_shopee_document_observations.sql";
async function main() {
  if (process.env.SEAMLESS_PRODUCTION_MIGRATION_VERIFY !== filename) throw new Error("Exact migration 025 confirmation required.");
  const tables = getTables();
  const applied = new Set((await pool.query(`SELECT filename FROM ${tables.schemaMigrations}`)).rows.map((row) => row.filename));
  const files = fs.readdirSync(path.join(__dirname, "../src/modules/seamless/db/migrations")).filter((name) => name.endsWith(".sql"));
  if (files.filter((name) => name.startsWith("025_")).length !== 1) throw new Error("Migration 025 collision.");
  if (process.argv[2] === "preflight") {
    if (files.some((name) => name !== filename && !applied.has(name))) throw new Error("Unapproved pending migration detected.");
  } else if (process.argv[2] === "verify") {
    if (!applied.has(filename)) throw new Error("Migration 025 missing from ledger.");
    await pool.query(`SELECT job_id, shop_code, report_type, date_from, date_to, portal_account,
      observed_at, result_status, reason_code, source_validation, payload_sha256, recorded_at
      FROM ${tables.shopeeDocumentObservations} LIMIT 0`);
  } else throw new Error("Expected preflight or verify.");
  console.log(`Shopee observation migration ${process.argv[2]} passed.`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
