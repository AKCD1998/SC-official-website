const fs = require("node:fs");
const path = require("node:path");
const pool = require("../db");
const { getTables } = require("../src/modules/seamless/tables");
const filename = "025_shopee_document_observations.sql";
function verifyConstraints(rows) {
  const definitions = rows.map((row) => String(row.definition || ""));
  const required = [
    ["job_id", /PRIMARY KEY \(job_id\)/u],
    ["report_type", /report_type.*etax-receipt-invoice/u],
    ["result_status", /result_status.*no_file/u],
    ["reason_code", /reason_code.*SHOPEE_ETAX_NO_DOCUMENT_FOR_DATE/u],
    ["date equality", /date_to = date_from/u],
    ["payload SHA", /payload_sha256.*\^\[a-f0-9\]\{64\}\$/u],
    ["shop scope", /shop_code.*sc-drug-store.*dr-morepen/u],
    ["shop/account mapping", /shop_code.*sc-drug-store.*portal_account.*142wuxqhgi.*shop_code.*dr-morepen.*portal_account.*mu3f314od9/u],
  ];
  for (const [name, pattern] of required) if (!definitions.some((value) => pattern.test(value))) {
    throw new Error(`Observation constraint missing: ${name}.`);
  }
}
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
    const constraints = await pool.query(`SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid = $1::regclass`, [tables.shopeeDocumentObservations]);
    verifyConstraints(constraints.rows);
  } else throw new Error("Expected preflight or verify.");
  console.log(`Shopee observation migration ${process.argv[2]} passed.`);
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
module.exports = { verifyConstraints };
