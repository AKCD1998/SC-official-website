import dotenv from "dotenv";
import pg from "pg";

const index = process.argv.indexOf("--env-file");
const envFile = index >= 0 ? process.argv[index + 1] : "";
if (!envFile) throw new Error("Pass --env-file explicitly");
dotenv.config({ path: envFile, quiet: true });
const connectionString = process.env.RX1011_DATABASE_URL;
if (!connectionString) throw new Error("RX1011_DATABASE_URL is missing");
const host = new URL(connectionString).hostname;
const { Client } = pg;
const client = new Client({
  connectionString,
  ssl: /localhost|127\.0\.0\.1/i.test(host) ? false : { rejectUnauthorized: false },
});
await client.connect();
try {
  const identity = await client.query(
    "SELECT current_database() AS database, (SELECT count(*) FROM products) AS products, to_regclass('ky11_bulk_source_snapshots') AS snapshot_table"
  );
  let snapshot = null;
  if (identity.rows[0].snapshot_table) {
    const result = await client.query(
      "SELECT snapshot_key, source_sha256, sales_row_count, lot_row_count, confirmed_paper_lot_count, simulated_lot_count FROM ky11_bulk_source_snapshots WHERE snapshot_key = $1",
      ["stockday-20260618-20260927-dev-v1"]
    );
    snapshot = result.rows[0] || null;
  }
  console.log(JSON.stringify({ host, ...identity.rows[0], snapshot }));
} finally {
  await client.end();
}
