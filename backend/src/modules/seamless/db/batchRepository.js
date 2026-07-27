const pool = require("../../../../db");
const { getTables } = require("../tables");

function executor(client) {
  return client || pool;
}

async function createBatch(batch, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `
      INSERT INTO ${tables.processingBatches} (
        formatter_mode,
        batch_mode,
        status,
        file_count,
        created_by
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `,
    [
      batch.formatterMode || null,
      batch.batchMode || "unknown",
      batch.status || "processing",
      batch.fileCount || 0,
      batch.createdBy || null,
    ],
  );

  return result.rows[0];
}

async function updateBatch(id, patch, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `
      UPDATE ${tables.processingBatches}
      SET
        status = COALESCE($2, status),
        success_count = COALESCE($3, success_count),
        failure_count = COALESCE($4, failure_count),
        finished_at = COALESCE($5, finished_at)
      WHERE id = $1
      RETURNING *
    `,
    [
      id,
      patch.status || null,
      Number.isFinite(patch.successCount) ? patch.successCount : null,
      Number.isFinite(patch.failureCount) ? patch.failureCount : null,
      patch.finishedAt || null,
    ],
  );

  return result.rows[0];
}

async function recordBatchResult(id, result, client = null) {
  const db = executor(client);
  const tables = getTables();
  const successIncrement = result.success ? 1 : 0;
  const failureIncrement = result.success ? 0 : 1;
  const status = result.status || null;
  const finishedAt = result.finishedAt || null;

  const response = await db.query(
    `
      UPDATE ${tables.processingBatches}
      SET
        success_count = success_count + $2,
        failure_count = failure_count + $3,
        status = COALESCE($4, status),
        finished_at = COALESCE($5, finished_at)
      WHERE id = $1
      RETURNING *
    `,
    [id, successIncrement, failureIncrement, status, finishedAt],
  );

  return response.rows[0];
}

module.exports = { createBatch, recordBatchResult, updateBatch };
