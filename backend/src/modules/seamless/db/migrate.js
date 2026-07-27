const fs = require("node:fs/promises");
const path = require("node:path");
const pool = require("../../../../db");
const { readSchemaName } = require("../config");
const { getTables, quoteIdentifier } = require("../tables");

const migrationsDir = path.resolve(__dirname, "migrations");

async function listSqlFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
}

async function ensureSchemaAndMigrationTable(client) {
  const schemaName = readSchemaName();
  const schemaSql = quoteIdentifier(schemaName, "schema");
  const tables = getTables();

  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaSql}`);
  await client.query(`SET search_path TO ${schemaSql}, public`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${tables.schemaMigrations} (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedMigrations(client) {
  const tables = getTables();
  const result = await client.query(`SELECT filename FROM ${tables.schemaMigrations}`);
  return new Set(result.rows.map((row) => row.filename));
}

// This runner reads/writes the SAME clasp_scx_seamless.schema_migrations table that
// ClaspSCxSeamless's own standalone runner already created and applied 001-003 against in
// production. Running this against that already-migrated database is expected to be a no-op —
// it must NOT re-apply anything already recorded there.
async function runMigrations() {
  const client = await pool.connect();

  try {
    await ensureSchemaAndMigrationTable(client);

    const applied = await getAppliedMigrations(client);
    const files = await listSqlFiles(migrationsDir);

    for (const filename of files) {
      if (applied.has(filename)) {
        console.log(`[seamless:migrate] Skipping already-applied migration: ${filename}`);
        continue;
      }

      const filePath = path.join(migrationsDir, filename);
      const sql = await fs.readFile(filePath, "utf8");

      console.log(`[seamless:migrate] Applying migration: ${filename}`);
      await client.query(sql);

      const tables = getTables();
      await client.query(`INSERT INTO ${tables.schemaMigrations} (filename) VALUES ($1)`, [filename]);
    }

    console.log("[seamless:migrate] Migrations complete.");
  } finally {
    client.release();
  }
}

const isDirectRun = require.main === module;

if (isDirectRun) {
  runMigrations()
    .then(() => pool.end())
    .catch((error) => {
      console.error("[seamless:migrate] Migration failed.");
      console.error(error);
      process.exitCode = 1;
    });
}

module.exports = { runMigrations };
