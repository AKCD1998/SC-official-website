const fs = require("node:fs/promises");
const path = require("node:path");
const pool = require("../db");
const { readSchemaName } = require("../src/modules/seamless/config");
const { getTables } = require("../src/modules/seamless/tables");

const APPROVED_MIGRATIONS = Object.freeze([
  "023_shopee_income_table_indexes.sql",
  "024_shopee_etax_documents.sql",
]);
const CONFIRMATION = APPROVED_MIGRATIONS.join("+");
const EXPECTED_INDEXES = Object.freeze([
  "idx_shopee_income_ordered_at",
  "idx_shopee_income_transferred_at",
]);
const EXPECTED_CONSTRAINTS = Object.freeze([
  ["shopee_sales_ingest_jobs", "shopee_sales_ingest_jobs_report_type_check"],
  ["shopee_official_document_sources", "shopee_official_document_sources_report_type_check"],
]);
const migrationsDirectory = path.resolve(__dirname, "../src/modules/seamless/db/migrations");

function assertProductionGate() {
  if (process.env.SEAMLESS_PRODUCTION_MIGRATION_VERIFY !== CONFIRMATION) {
    throw new Error("Exact production migrations 023+024 confirmation is required.");
  }
  if (!process.env.SC_OFFICIAL_SUPABASE_DATABASE_URL) {
    throw new Error("SC_OFFICIAL_SUPABASE_DATABASE_URL is required.");
  }
}

async function expectedPrerequisites() {
  const entries = await fs.readdir(migrationsDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .filter((filename) => filename < APPROVED_MIGRATIONS[0])
    .sort();
}

async function readAppliedMigrations(tables) {
  const result = await pool.query(`SELECT filename FROM ${tables.schemaMigrations} ORDER BY filename`);
  return new Set(result.rows.map((row) => row.filename));
}

async function preflight(tables) {
  const applied = await readAppliedMigrations(tables);
  const missing = (await expectedPrerequisites()).filter((filename) => !applied.has(filename));
  if (missing.length) {
    throw new Error(`Refusing migrations 023+024 because prerequisites are missing: ${missing.join(", ")}`);
  }
  console.log("[seamless:production:migrate] Preconditions passed for approved migrations 023+024.");
}

async function verify(tables, schemaName) {
  const applied = await readAppliedMigrations(tables);
  const missingMigrations = APPROVED_MIGRATIONS.filter((filename) => !applied.has(filename));
  if (missingMigrations.length) {
    throw new Error(`Approved migrations are not recorded: ${missingMigrations.join(", ")}`);
  }

  const indexes = await pool.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = $1 AND tablename = 'shopee_income_facts'
        AND indexname = ANY($2::text[])`,
    [schemaName, EXPECTED_INDEXES],
  );
  const foundIndexes = new Set(indexes.rows.map((row) => row.indexname));
  const missingIndexes = EXPECTED_INDEXES.filter((indexName) => !foundIndexes.has(indexName));
  if (missingIndexes.length) throw new Error(`Migration 023 indexes are missing: ${missingIndexes.join(", ")}`);

  const constraints = await pool.query(
    `SELECT c.relname AS table_name, pc.conname, pg_get_constraintdef(pc.oid) AS definition
       FROM pg_constraint pc
       JOIN pg_class c ON c.oid = pc.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND (c.relname, pc.conname) IN (
          ('shopee_sales_ingest_jobs', 'shopee_sales_ingest_jobs_report_type_check'),
          ('shopee_official_document_sources', 'shopee_official_document_sources_report_type_check')
        )`,
    [schemaName],
  );
  const definitions = new Map(constraints.rows.map((row) => [
    `${row.table_name}:${row.conname}`,
    String(row.definition || ""),
  ]));
  const invalidConstraints = EXPECTED_CONSTRAINTS.filter(([tableName, constraintName]) => (
    !definitions.get(`${tableName}:${constraintName}`)?.includes("etax-receipt-invoice")
  ));
  if (invalidConstraints.length) {
    throw new Error(`Migration 024 e-Tax constraints are missing or stale: ${invalidConstraints.map((item) => item.join(".")).join(", ")}`);
  }
  console.log(`[seamless:production:migrate] Verified migrations 023+024 in ${schemaName}.`);
}

async function main(mode = process.argv[2]) {
  assertProductionGate();
  const tables = getTables();
  if (mode === "preflight") return preflight(tables);
  if (mode === "verify") return verify(tables, readSchemaName());
  throw new Error("Mode must be preflight or verify.");
}

if (require.main === module) {
  main()
    .then(() => pool.end())
    .catch(async (error) => {
      console.error("[seamless:production:migrate] Approved 023+024 rollout gate failed.");
      console.error(error.message);
      await pool.end().catch(() => {});
      process.exitCode = 1;
    });
}

module.exports = {
  APPROVED_MIGRATIONS,
  CONFIRMATION,
  EXPECTED_CONSTRAINTS,
  EXPECTED_INDEXES,
  expectedPrerequisites,
  main,
};

