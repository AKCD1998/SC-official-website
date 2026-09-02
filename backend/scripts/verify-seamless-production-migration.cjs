const pool = require("../db");
const { readSchemaName } = require("../src/modules/seamless/config");
const { getTables } = require("../src/modules/seamless/tables");

const APPROVED_MIGRATION = "014_shopee_financial_visibility_settings.sql";

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

  const tableName = "shopee_financial_visibility_settings";
  const relation = await pool.query("SELECT to_regclass($1) AS relation", [
    `${schemaName}.${tableName}`,
  ]);
  if (!relation.rows[0]?.relation) throw new Error(`Missing migrated table: ${tableName}`);

  const settings = await pool.query(
    `
      SELECT
        user_can_view_unit_price,
        user_can_view_shipping_fee,
        user_can_view_total_amount
      FROM ${tables.shopeeFinancialVisibilitySettings}
      WHERE setting_key = 'user'
    `,
  );
  if (settings.rows.length !== 1) {
    throw new Error("Shopee user financial visibility singleton is missing.");
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
