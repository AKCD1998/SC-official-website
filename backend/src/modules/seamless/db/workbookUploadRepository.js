const pool = require("../../../../db");
const { getTables } = require("../tables");

function executor(client) {
  return client || pool;
}

async function createWorkbookUpload(upload, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `
      INSERT INTO ${tables.workbookUploads} (
        batch_id,
        original_filename,
        mime_type,
        file_size_bytes,
        requested_variant,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `,
    [
      upload.batchId || null,
      upload.originalFilename,
      upload.mimeType || null,
      upload.fileSizeBytes || null,
      upload.requestedVariant || null,
      upload.status || "processing",
    ],
  );

  return result.rows[0];
}

async function updateWorkbookUpload(id, patch, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `
      UPDATE ${tables.workbookUploads}
      SET
        processing_record_id = COALESCE($2, processing_record_id),
        detected_variant = COALESCE($3, detected_variant),
        effective_variant = COALESCE($4, effective_variant),
        status = COALESCE($5, status),
        error_message = $6,
        warnings = COALESCE($7::jsonb, warnings),
        deleted_columns = COALESCE($8::jsonb, deleted_columns),
        highlight_count = COALESCE($9, highlight_count),
        transform_summary = COALESCE($10::jsonb, transform_summary)
      WHERE id = $1
      RETURNING *
    `,
    [
      id,
      patch.processingRecordId || null,
      patch.detectedVariant || null,
      patch.effectiveVariant || null,
      patch.status || null,
      patch.errorMessage || null,
      patch.warnings ? JSON.stringify(patch.warnings) : null,
      patch.deletedColumns ? JSON.stringify(patch.deletedColumns) : null,
      Number.isFinite(patch.highlightCount) ? patch.highlightCount : null,
      patch.transformSummary ? JSON.stringify(patch.transformSummary) : null,
    ],
  );

  return result.rows[0];
}

module.exports = {
  createWorkbookUpload,
  updateWorkbookUpload,
};
