const pool = require("../db");
const { readSchemaName } = require("../src/modules/seamless/config");
const { getTables } = require("../src/modules/seamless/tables");

const APPROVED_MIGRATION = "011_shopee_legacy_reconciliation_apply_audit.sql";

async function verify() {
  if (process.env.SEAMLESS_PRODUCTION_MIGRATION_VERIFY !== APPROVED_MIGRATION) {
    throw new Error("Exact production migration confirmation is required.");
  }
  if (!process.env.SC_OFFICIAL_SUPABASE_DATABASE_URL) {
    throw new Error("SC_OFFICIAL_SUPABASE_DATABASE_URL is required.");
  }

  const schemaName = readSchemaName();
  const tables = getTables();
  const migration = await pool.query(
    `SELECT filename FROM ${tables.schemaMigrations} WHERE filename = $1`,
    [APPROVED_MIGRATION],
  );
  if (migration.rows.length !== 1) {
    throw new Error("Approved migration is not recorded in schema_migrations.");
  }

  for (const tableName of [
    "shopee_legacy_reconciliation_apply_batches",
    "shopee_legacy_reconciliation_apply_items",
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await pool.query("SELECT to_regclass($1) AS relation", [
      `${schemaName}.${tableName}`,
    ]);
    if (!result.rows[0]?.relation) throw new Error(`Missing migrated table: ${tableName}`);
  }

  console.log(`[seamless:production:migrate] Verified ${APPROVED_MIGRATION} in ${schemaName}.`);
}

verify()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error("[seamless:production:migrate] Verification failed.");
    console.error(error.message);
    await pool.end().catch(() => {});
    process.exitCode = 1;
  });
