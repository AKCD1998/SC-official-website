import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./migrate.js";
import { runSeed } from "./seed.js";
import { closePool } from "./pool.js";

export async function runDatabaseSetup() {
  await runMigrations();
  await runSeed();
  console.log("Database setup complete.");
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  runDatabaseSetup()
    .catch((error) => {
      console.error("Database setup failed:", error.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool();
    });
}
