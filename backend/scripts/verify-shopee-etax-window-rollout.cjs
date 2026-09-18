const fs = require("node:fs");
const path = require("node:path");
const pool = require("../db");
const { getTables } = require("../src/modules/seamless/tables");
const { verifyConstraints } = require("./verify-shopee-observation-rollout.cjs");
const filename = "026_shopee_etax_available_window.sql";
function verifyWindowConstraints(rows) {
  verifyConstraints(rows);
  const definitions = new Map(rows.map((row) => [row.conname, String(row.definition || "")]));
  const required = {
    shopee_document_observations_result_status_check: ["no_file", "unavailable"],
    shopee_document_observations_reason_code_check: ["SHOPEE_ETAX_NO_DOCUMENT_FOR_DATE", "SHOPEE_ETAX_DATE_OUTSIDE_AVAILABLE_WINDOW"],
    shopee_document_observations_status_reason_check: ["no_file", "unavailable", "SHOPEE_ETAX_NO_DOCUMENT_FOR_DATE", "SHOPEE_ETAX_DATE_OUTSIDE_AVAILABLE_WINDOW", " AND ", " OR "],
    shopee_document_observations_window_proof_check: ["unavailable", "COALESCE", "portalAccount", "portal_account", "requestedDate", "date_from", "portalPath", "/tax/download", "endDateUnset", "pickerLowerBoundVerified", "earliestAvailableDate", "requestedDateDisabled", "?&", "'{}'::jsonb", "::date > date_from", "false"],
  };
  for (const [name, fragments] of Object.entries(required)) {
    if (!fragments.every((fragment) => definitions.get(name)?.includes(fragment))) throw new Error(`Migration 026 constraint missing/stale: ${name}`);
  }
}
async function main() {
  if (process.env.SEAMLESS_PRODUCTION_MIGRATION_VERIFY !== filename) throw new Error("Exact migration 026 confirmation required.");
  const tables = getTables();
  const applied = new Set((await pool.query(`SELECT filename FROM ${tables.schemaMigrations}`)).rows.map((row) => row.filename));
  const files = fs.readdirSync(path.join(__dirname, "../src/modules/seamless/db/migrations")).filter((name) => name.endsWith(".sql"));
  if (files.filter((name) => name.startsWith("026_")).length !== 1) throw new Error("Migration 026 collision.");
  if (process.argv[2] === "preflight") {
    if (files.some((name) => name !== filename && !applied.has(name))) throw new Error("Unapproved pending migration detected.");
  } else if (process.argv[2] === "verify") {
    if (!applied.has(filename)) throw new Error("Migration 026 missing from ledger.");
    const constraints = await pool.query(`SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid = $1::regclass`, [tables.shopeeDocumentObservations]);
    verifyWindowConstraints(constraints.rows);
  } else throw new Error("Expected preflight or verify.");
  console.log(`Shopee e-Tax window migration ${process.argv[2]} passed.`);
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
module.exports = { verifyWindowConstraints };
