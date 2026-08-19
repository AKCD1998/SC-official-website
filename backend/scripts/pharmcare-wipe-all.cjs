#!/usr/bin/env node
// One-time full wipe of pharmcare_email_messages (attachments/documents cascade-delete with
// their parent message row) — used once on 2026-08-19 to clear data ingested under the old
// too-broad Gmail query + the nested-MIME body-parsing bug, ahead of a clean re-backfill.
// DB only, never touches Gmail. Requires --execute to actually delete (otherwise just previews
// the count).
//
// Usage:
//   node scripts/pharmcare-wipe-all.cjs             (preview count only)
//   node scripts/pharmcare-wipe-all.cjs --execute    (actually delete everything)

"use strict";

require("dotenv").config();

const pool = require("../db");
const { getTables } = require("../src/modules/seamless/tables");

async function main() {
  const execute = process.argv.includes("--execute");
  const tables = getTables();

  const before = await pool.query(`SELECT COUNT(*)::int AS count FROM ${tables.pharmcareEmailMessages}`);
  console.log(`pharmcare_email_messages currently has ${before.rows[0].count} row(s).`);

  if (!execute) {
    console.log("Preview only — nothing was deleted. Re-run with --execute to actually delete everything.");
    await pool.end();
    return;
  }

  const result = await pool.query(`DELETE FROM ${tables.pharmcareEmailMessages}`);
  console.log(`Deleted ${result.rowCount} message row(s) (attachments/documents cascade-deleted with them).`);
  await pool.end();
}

main().catch((error) => {
  console.error("[pharmcare-wipe-all] failed:", error.message);
  process.exitCode = 1;
});
