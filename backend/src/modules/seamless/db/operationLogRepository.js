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

async function listOperationLogsForRecord(processingRecordId, limit = 100, client = null) {
  const executor = client || pool;
  const tables = getTables();
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const result = await executor.query(
    `
      SELECT id, scope, level, action, message, metadata, actor, created_at
      FROM ${tables.operationLogs}
      WHERE processing_record_id = $1
      ORDER BY created_at ASC
      LIMIT $2
    `,
    [processingRecordId, safeLimit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    level: row.level,
    action: row.action,
    message: row.message || "",
    metadata: row.metadata || {},
    actor: row.actor || "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  }));
}

module.exports = { listOperationLogsForRecord, logOperation };
