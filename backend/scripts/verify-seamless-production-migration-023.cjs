const fs = require("node:fs/promises");
const path = require("node:path");
const pool = require("../db");
const { readSchemaName } = require("../src/modules/seamless/config");
const { getTables } = require("../src/modules/seamless/tables");

const APPROVED_MIGRATION = "023_shopee_income_table_indexes.sql";
const EXPECTED_INDEXES = [
  "idx_shopee_income_ordered_at",
  "idx_shopee_income_transferred_at",
];
const migrationsDirectory = path.resolve(
  __dirname,
  "../src/modules/seamless/db/migrations",
);

function assertProductionGate() {
  if (process.env.SEAMLESS_PRODUCTION_MIGRATION_VERIFY !== APPROVED_MIGRATION) {
    throw new Error("Exact production migration 023 confirmation is required.");
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
    .filter((filename) => filename < APPROVED_MIGRATION)
    .sort();
}

async function readAppliedMigrations(tables) {
  const result = await pool.query(
    `SELECT filename FROM ${tables.schemaMigrations} ORDER BY filename`,
  );
  return new Set(result.rows.map((row) => row.filename));
}

async function preflight(tables) {
  const applied = await readAppliedMigrations(tables);
  const missing = (await expectedPrerequisites())
    .filter((filename) => !applied.has(filename));
  if (missing.length) {
    throw new Error(
      `Refusing migration 023 because prerequisite migrations are missing: ${missing.join(", ")}`,
    );
  }
  console.log(
    applied.has(APPROVED_MIGRATION)
      ? `[seamless:production:migrate] ${APPROVED_MIGRATION} is already recorded; verification will remain idempotent.`
      : `[seamless:production:migrate] Preconditions passed for ${APPROVED_MIGRATION}.`,
  );
}

async function verify(tables, schemaName) {
  const applied = await readAppliedMigrations(tables);
  if (!applied.has(APPROVED_MIGRATION)) {
    throw new Error(`${APPROVED_MIGRATION} is not recorded in schema_migrations.`);
  }
  const indexes = await pool.query(
    `
      SELECT indexname
        FROM pg_indexes
       WHERE schemaname = $1
         AND tablename = 'shopee_income_facts'
         AND indexname = ANY($2::text[])
    `,
    [schemaName, EXPECTED_INDEXES],
  );
  const found = new Set(indexes.rows.map((row) => row.indexname));
  const missing = EXPECTED_INDEXES.filter((indexName) => !found.has(indexName));
  if (missing.length) {
    throw new Error(`Migration 023 indexes are missing: ${missing.join(", ")}`);
  }
  console.log(
    `[seamless:production:migrate] Verified ${APPROVED_MIGRATION} and both Income indexes in ${schemaName}.`,
  );
}

async function main(mode = process.argv[2]) {
  assertProductionGate();
  const schemaName = readSchemaName();
  const tables = getTables();
  if (mode === "preflight") return preflight(tables);
  if (mode === "verify") return verify(tables, schemaName);
  throw new Error("Mode must be preflight or verify.");
}

if (require.main === module) {
  main()
    .then(() => pool.end())
    .catch(async (error) => {
      console.error("[seamless:production:migrate] Migration 023 gate failed.");
      console.error(error.message);
      await pool.end().catch(() => {});
      process.exitCode = 1;
    });
}

module.exports = {
  APPROVED_MIGRATION,
  EXPECTED_INDEXES,
  expectedPrerequisites,
  main,
};
