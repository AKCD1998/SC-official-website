import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { query } from "../db/pool.js";
import { httpError } from "../utils/httpError.js";

const OCT24 = {
  key: "stockday-pos-20260618-20261024-dev-v1",
  filename: "KY11_Source_27_Products_20260618-20261024_DRAFT_UNVERIFIED_v1.csv",
  sha256: "bc8e65ca1d78a9e5a7be2130d56ca9f446b89f8312939b36c87aef74f228e5d6",
  start: "2026-06-18",
  end: "2026-10-24",
  sales: 3849,
  lots: 97,
  paper: 19,
  simulated: 78,
};

export function validateOct24Ky11Source(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw httpError(400, "CSV source is required");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== OCT24.sha256) throw httpError(422, "CSV checksum differs from the reviewed October 24 source");
  const csv = bytes.toString("utf8");
  let rows;
  try { rows = parse(csv, { columns: true, bom: true, skip_empty_lines: true }); }
  catch { throw httpError(422, "Invalid combined CSV"); }
  const sales = rows.filter((row) => row.recordType === "SALE");
  const lots = rows.filter((row) => row.recordType === "LOT");
  const paper = lots.filter((row) => row.receiptBasis?.startsWith("PAPER_CONFIRMED"));
  const simulated = lots.filter((row) => row.receiptBasis?.includes("SIMULATED"));
  if (sales.length !== OCT24.sales || lots.length !== OCT24.lots ||
      paper.length !== OCT24.paper || simulated.length !== OCT24.simulated ||
      sales.some((row) => row.saleDate < OCT24.start || row.saleDate > OCT24.end)) {
    throw httpError(422, "CSV row counts, provenance or dates differ from the reviewed snapshot");
  }
  return { ...OCT24, csv };
}

export async function putKy11Oct24SourceSnapshot(req, res) {
  if (req.params.snapshotKey !== OCT24.key) throw httpError(404, "Unknown KY11 snapshot key");
  const snapshot = validateOct24Ky11Source(req.body);
  const existing = await query(
    "SELECT source_sha256 FROM ky11_bulk_source_snapshots WHERE snapshot_key = $1",
    [snapshot.key]
  );
  if (existing.rows.length && existing.rows[0].source_sha256.trim() !== snapshot.sha256) {
    throw httpError(409, "Snapshot key already exists with different content");
  }
  if (!existing.rows.length) {
    await query(
      `INSERT INTO ky11_bulk_source_snapshots
       (snapshot_key, period_start, period_end, source_filename, source_sha256, source_csv,
        sales_row_count, lot_row_count, confirmed_paper_lot_count, simulated_lot_count, source_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'DEVELOPMENT_REFERENCE')
       ON CONFLICT (snapshot_key) DO NOTHING`,
      [snapshot.key, snapshot.start, snapshot.end, snapshot.filename, snapshot.sha256, snapshot.csv,
        snapshot.sales, snapshot.lots, snapshot.paper, snapshot.simulated]
    );
  }
  const stored = await query(
    "SELECT source_csv, source_sha256 FROM ky11_bulk_source_snapshots WHERE snapshot_key = $1",
    [snapshot.key]
  );
  if (!stored.rows.length || stored.rows[0].source_sha256.trim() !== snapshot.sha256 ||
      createHash("sha256").update(stored.rows[0].source_csv, "utf8").digest("hex") !== snapshot.sha256) {
    throw httpError(500, "Stored KY11 snapshot checksum mismatch");
  }
  res.set("Cache-Control", "private, no-store");
  res.status(existing.rows.length ? 200 : 201).json({
    snapshotKey: snapshot.key, sourceSha256: snapshot.sha256,
    periodStart: snapshot.start, periodEnd: snapshot.end,
    sourceStatus: "DEVELOPMENT_REFERENCE", salesRowCount: snapshot.sales,
    lotRowCount: snapshot.lots, alreadyPresent: Boolean(existing.rows.length),
  });
}

export async function getKy11BulkSourceSnapshot(req, res) {
  const snapshotKey = String(req.params.snapshotKey || "").trim();
  const result = await query(
    `SELECT source_csv, source_sha256
       FROM ky11_bulk_source_snapshots
      WHERE snapshot_key = $1`,
    [snapshotKey]
  );
  const snapshot = result.rows[0];
  if (!snapshot) throw httpError(404, "KY11 source snapshot not found");
  const actualSha256 = createHash("sha256").update(snapshot.source_csv, "utf8").digest("hex");
  if (actualSha256 !== snapshot.source_sha256.trim()) {
    throw httpError(500, "KY11 source snapshot checksum mismatch");
  }

  res.set("Cache-Control", "private, no-store");
  res.set("X-Content-Type-Options", "nosniff");
  res.type("text/csv; charset=utf-8");
  res.send(snapshot.source_csv);
}
