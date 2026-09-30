import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";
import { parse } from "csv-parse/sync";

const SNAPSHOT_KEY = "stockday-20260618-20260927-dev-v1";
const EXPECTED_SHA256 = "6a59c4d353e7e50ea3c2e9115ca7684763ce55f19ec58598743c4c70a3d5f366";
const EXPECTED_COUNTS = { SALE: 3209, LOT: 97, PAPER: 19, SIMULATED: 78 };
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? "" : String(args[index + 1] || "").trim();
};
const fail = (message) => { throw new Error(message); };
const file = option("--file");
if (!file) fail("Pass --file with the exact combined CSV path");
const bytes = await fs.readFile(file);
const sha256 = createHash("sha256").update(bytes).digest("hex");
if (sha256 !== EXPECTED_SHA256) fail("CSV checksum differs from the reviewed 2026-09-30 file");
const csv = bytes.toString("utf8");
const rows = parse(csv, { columns: true, bom: true, skip_empty_lines: true });
const counts = {
  SALE: rows.filter((row) => row.recordType === "SALE").length,
  LOT: rows.filter((row) => row.recordType === "LOT").length,
  PAPER: rows.filter((row) => row.recordType === "LOT" && row.receiptBasis?.startsWith("PAPER_CONFIRMED")).length,
  SIMULATED: rows.filter((row) => row.recordType === "LOT" && row.receiptBasis?.includes("SIMULATED")).length,
};
if (rows.length !== EXPECTED_COUNTS.SALE + EXPECTED_COUNTS.LOT ||
    Object.entries(EXPECTED_COUNTS).some(([type, expected]) => counts[type] !== expected)) {
  fail("CSV row counts or lot provenance differ from the reviewed snapshot");
}
if (rows.some((row) => !["SALE", "LOT"].includes(row.recordType))) fail("Unexpected recordType");
if (rows.some((row) => row.recordType === "SALE" && (row.saleDate < "2026-06-18" || row.saleDate > "2026-09-27"))) {
  fail("A sale falls outside the frozen reporting period");
}

const result = { snapshotKey: SNAPSHOT_KEY, sha256, bytes: bytes.length, counts, action: "validated" };
const rehearse = args.includes("--rehearse");
const apply = args.includes("--apply");
if (rehearse && apply) fail("Choose only one of --rehearse or --apply");
if (!apply && !rehearse) {
  console.log(JSON.stringify(result));
  process.exit(0);
}

const envFile = option("--env-file");
const expectedHost = option("--expect-host");
if (!envFile || !expectedHost) fail("--rehearse/--apply requires --env-file and --expect-host");
dotenv.config({ path: envFile, quiet: true });
const connectionString = process.env.RX1011_DATABASE_URL;
if (!connectionString) fail("RX1011_DATABASE_URL is missing; generic DATABASE_URL is never used");
const actualHost = new URL(connectionString).hostname;
if (actualHost !== expectedHost) fail("RX1011 database host differs from --expect-host");

const { Client } = pg;
const client = new Client({
  connectionString,
  ssl: /localhost|127\.0\.0\.1/i.test(actualHost) ? false : { rejectUnauthorized: false },
});
const here = path.dirname(fileURLToPath(import.meta.url));
const migration = await fs.readFile(path.join(here, "../src/modules/rx1011/migrations/0028_ky11_bulk_source_snapshots.sql"), "utf8");
await client.connect();
try {
  await client.query("BEGIN");
  const identity = await client.query("SELECT current_database() AS name");
  await client.query(migration);
  const existing = await client.query(
    "SELECT source_sha256 FROM ky11_bulk_source_snapshots WHERE snapshot_key = $1",
    [SNAPSHOT_KEY]
  );
  if (existing.rows.length) {
    if (existing.rows[0].source_sha256.trim() !== sha256) fail("Snapshot key already exists with different bytes");
    result.action = "already-present";
  } else {
    await client.query(
      `INSERT INTO ky11_bulk_source_snapshots
       (snapshot_key, period_start, period_end, source_filename, source_sha256, source_csv,
        sales_row_count, lot_row_count, confirmed_paper_lot_count, simulated_lot_count, source_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'DEVELOPMENT_REFERENCE')`,
      [SNAPSHOT_KEY, "2026-06-18", "2026-09-27", path.basename(file), sha256, csv,
        counts.SALE, counts.LOT, counts.PAPER, counts.SIMULATED]
    );
    result.action = "inserted";
  }
  const verified = await client.query(
    "SELECT source_csv, source_sha256 FROM ky11_bulk_source_snapshots WHERE snapshot_key = $1",
    [SNAPSHOT_KEY]
  );
  const storedHash = createHash("sha256").update(verified.rows[0].source_csv, "utf8").digest("hex");
  if (storedHash !== sha256 || verified.rows[0].source_sha256.trim() !== sha256) fail("Stored snapshot checksum mismatch");
  await client.query(rehearse ? "ROLLBACK" : "COMMIT");
  if (rehearse) result.action = "rehearsed-and-rolled-back";
  console.log(JSON.stringify({ ...result, database: identity.rows[0].name, host: actualHost }));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
