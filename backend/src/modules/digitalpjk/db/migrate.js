import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, hasDatabase, pool } from "./pool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.join(__dirname, "migrations");

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id BIGSERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getPendingMigrations(client) {
  const files = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  const applied = await client.query("SELECT filename FROM schema_migrations;");
  const appliedSet = new Set(applied.rows.map((row) => row.filename));

  return files.filter((file) => !appliedSet.has(file));
}

export async function runMigrations() {
  if (!hasDatabase()) {
    throw new Error("DIGITALPJK_DATABASE_URL is required to run migrations.");
  }

  const client = await pool.connect();
  try {
    await ensureMigrationTable(client);
    const pendingMigrations = await getPendingMigrations(client);

    if (pendingMigrations.length === 0) {
      console.log("No pending migrations.");
      return;
    }

    for (const filename of pendingMigrations) {
      const filePath = path.join(migrationsDir, filename);
      const sql = await readFile(filePath, "utf8");

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1);", [filename]);
        await client.query("COMMIT");
        console.log(`Applied migration: ${filename}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Failed migration ${filename}: ${error.message}`);
      }
    }
  } finally {
    client.release();
  }
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  runMigrations()
    .catch((error) => {
      console.error("Migration failed:", error.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool();
    });
}
