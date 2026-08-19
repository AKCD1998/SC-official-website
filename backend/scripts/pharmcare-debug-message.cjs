#!/usr/bin/env node
// Debug helper: prints the stored raw_subject + full metadata for a message that failed to
// parse an original sender, so the forwarded-block parser bug can be diagnosed without touching
// Gmail. DB-read only, no writes.
//
// Usage: node scripts/pharmcare-debug-message.cjs <gmail_message_id>
// Or with no id: prints the first N manual_forward messages with an empty original_from.

"use strict";

require("dotenv").config();

const pool = require("../db");
const { getTables } = require("../src/modules/seamless/tables");

async function main() {
  const tables = getTables();
  const messageId = process.argv[2];

  if (messageId) {
    const result = await pool.query(
      `SELECT * FROM ${tables.pharmcareEmailMessages} WHERE gmail_message_id = $1`,
      [messageId],
    );
    console.log(JSON.stringify(result.rows[0], null, 2));
  } else {
    const result = await pool.query(
      `
        SELECT id, gmail_message_id, route, raw_subject, normalized_subject, original_from,
               original_subject, original_date, metadata
        FROM ${tables.pharmcareEmailMessages}
        WHERE route = 'manual_forward' AND (original_from IS NULL OR original_from = '')
        ORDER BY received_at DESC
        LIMIT 5
      `,
    );
    result.rows.forEach((row, i) => {
      console.log(`--- #${i + 1} ---`);
      console.log(JSON.stringify(row, null, 2));
    });
  }

  await pool.end();
}

main().catch((error) => {
  console.error("[pharmcare-debug-message] failed:", error.message);
  process.exitCode = 1;
});
