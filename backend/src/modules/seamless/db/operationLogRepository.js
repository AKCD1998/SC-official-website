const pool = require("../../../../db");
const { getTables } = require("../tables");

async function logOperation(entry, client = null) {
  const executor = client || pool;
  const tables = getTables();
  const level = entry.level || "INFO";
  const metadata = entry.metadata || {};

  try {
    await executor.query(
      `
        INSERT INTO ${tables.operationLogs} (
          scope,
          level,
          action,
          message,
          metadata,
          actor,
          processing_record_id,
          batch_id,
          upload_id,
          generated_file_id
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
      `,
      [
        entry.scope || "api",
        level,
        entry.action,
        entry.message || "",
        JSON.stringify(metadata),
        entry.actor || null,
        entry.processingRecordId || null,
        entry.batchId || null,
        entry.uploadId || null,
        entry.generatedFileId || null,
      ],
    );
  } catch (error) {
    console.warn(`[operation_logs] skipped ${entry.action || "unknown"}: ${error.message}`);
  }

  const logLine = `[${entry.scope || "api"}] ${entry.action}: ${entry.message || ""}`;
  if (level === "ERROR") {
    console.error(logLine);
  } else if (level === "WARN") {
    console.warn(logLine);
  } else {
    console.log(logLine);
  }
}

module.exports = { logOperation };
