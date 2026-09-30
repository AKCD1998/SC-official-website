import { createHash } from "node:crypto";
import { query } from "../db/pool.js";
import { httpError } from "../utils/httpError.js";

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
