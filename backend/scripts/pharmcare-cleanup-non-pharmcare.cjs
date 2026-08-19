#!/usr/bin/env node
// One-time cleanup for messages ingested before the SEAMLESS_PHARMCARE_GMAIL_QUERY fix
// (2026-08-19): the old default query (`from:auukunn.bkk@gmail.com` with no content filter)
// pulled in unrelated forwarded mail (observed live: branch call-tracking reports from an
// unrelated "CI Reports Bot"), not just genuine PharmCare forwards. This deletes every
// pharmcare_email_messages row whose resolved original_from is not info@pharmcare.co —
// attachments and documents cascade-delete with their parent message row (see migration 006).
//
// Defaults to a DRY RUN (prints what would be deleted, deletes nothing). Pass --execute to
// actually delete. Never touches Gmail — DB only.
//
// Usage:
//   node scripts/pharmcare-cleanup-non-pharmcare.cjs             (dry run / preview)
//   node scripts/pharmcare-cleanup-non-pharmcare.cjs --execute   (actually delete)

"use strict";

require("dotenv").config();

const pool = require("../db");
const { getTables } = require("../src/modules/seamless/tables");

const ALLOWED_SENDER = "info@pharmcare.co";

async function main() {
  const execute = process.argv.includes("--execute");
  const tables = getTables();

  const preview = await pool.query(
    `
      SELECT id, gmail_message_id, route, original_from, normalized_subject, received_at
      FROM ${tables.pharmcareEmailMessages}
      WHERE original_from IS DISTINCT FROM $1
      ORDER BY received_at DESC
    `,
    [ALLOWED_SENDER],
  );

  console.log(`Found ${preview.rows.length} message(s) with original_from != '${ALLOWED_SENDER}':\n`);
  preview.rows.slice(0, 20).forEach((row) => {
    console.log(
      `  - ${row.received_at?.toISOString?.() || row.received_at}  [${row.route}]  from=${row.original_from || "(empty)"}  "${row.normalized_subject || ""}"`,
    );
  });
  if (preview.rows.length > 20) {
    console.log(`  ... and ${preview.rows.length - 20} more`);
  }

  const totalResult = await pool.query(`SELECT COUNT(*)::int AS count FROM ${tables.pharmcareEmailMessages}`);
  console.log(`\nTotal messages in pharmcare_email_messages: ${totalResult.rows[0].count}`);
  console.log(`Would delete: ${preview.rows.length}`);
  console.log(`Would remain: ${totalResult.rows[0].count - preview.rows.length}`);

  if (!execute) {
    console.log("\nDry run only — nothing was deleted. Re-run with --execute to actually delete these rows.");
    await pool.end();
    return;
  }

  if (preview.rows.length === 0) {
    console.log("\nNothing to delete.");
    await pool.end();
    return;
  }

  const ids = preview.rows.map((row) => row.id);
  const deleteResult = await pool.query(
    `DELETE FROM ${tables.pharmcareEmailMessages} WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  console.log(`\nDeleted ${deleteResult.rowCount} message row(s) (attachments/documents cascade-deleted with them).`);
  await pool.end();
}

main().catch((error) => {
  console.error("[pharmcare-cleanup] failed:", error.message);
  process.exitCode = 1;
});
