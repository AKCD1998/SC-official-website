const pool = require("../../../../db");
const { notFound } = require("../errors");
const { getTables } = require("../tables");

function executor(client) {
  return client || pool;
}

function mapGeneratedFile(row) {
  return {
    id: row.id,
    processingRecordId: row.processing_record_id || "",
    batchId: row.batch_id || "",
    uploadId: row.upload_id || "",
    fileKind: row.file_kind,
    filename: row.filename,
    mimeType: row.mime_type || "",
    storageProvider: row.storage_provider,
    storagePath: row.storage_path || "",
    downloadUrl: row.download_url || "",
    viewUrl: row.view_url || "",
    fileSizeBytes: row.file_size_bytes || 0,
    checksumSha256: row.checksum_sha256 || "",
    legacyDriveFileId: row.legacy_drive_file_id || "",
    legacyDriveFileUrl: row.legacy_drive_file_url || "",
    metadata: row.metadata || {},
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

async function createGeneratedFile(file, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `
      INSERT INTO ${tables.generatedFiles} (
        processing_record_id,
        batch_id,
        upload_id,
        file_kind,
        filename,
        mime_type,
        storage_provider,
        storage_path,
        download_url,
        view_url,
        file_size_bytes,
        checksum_sha256,
        legacy_drive_file_id,
        legacy_drive_file_url,
        legacy_google_mime_type,
        metadata,
        expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17)
      RETURNING *
    `,
    [
      file.processingRecordId || null,
      file.batchId || null,
      file.uploadId || null,
      file.fileKind,
      file.filename,
      file.mimeType || null,
      file.storageProvider || "local",
      file.storagePath || null,
      file.downloadUrl || null,
      file.viewUrl || null,
      file.fileSizeBytes || null,
      file.checksumSha256 || null,
      file.legacyDriveFileId || null,
      file.legacyDriveFileUrl || null,
      file.legacyGoogleMimeType || null,
      JSON.stringify(file.metadata || {}),
      file.expiresAt || null,
    ],
  );

  return mapGeneratedFile(result.rows[0]);
}

async function getGeneratedFileById(id, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(`SELECT * FROM ${tables.generatedFiles} WHERE id = $1`, [id]);

  if (!result.rows.length) {
    throw notFound(`Generated file not found for id: ${id}`);
  }

  return mapGeneratedFile(result.rows[0]);
}

async function findSourceUploadByChecksum(checksumSha256, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `
      SELECT
        gf.*,
        wu.original_filename,
        wu.created_at AS upload_created_at,
        pr.id AS processing_record_id_ref,
        pr.filename AS processing_record_filename,
        pr.report_date_key,
        pr.report_type,
        pr.uploaded_at AS processing_record_uploaded_at
      FROM ${tables.generatedFiles} gf
      LEFT JOIN ${tables.workbookUploads} wu ON wu.id = gf.upload_id
      LEFT JOIN ${tables.processingRecords} pr ON pr.id = gf.processing_record_id
      WHERE gf.file_kind = 'source_upload'
        AND gf.checksum_sha256 = $1
      ORDER BY gf.created_at DESC
      LIMIT 1
    `,
    [checksumSha256],
  );

  if (!result.rows.length) {
    return null;
  }

  const row = result.rows[0];
  return {
    ...mapGeneratedFile(row),
    originalFilename: row.original_filename || "",
    uploadCreatedAt:
      row.upload_created_at instanceof Date
        ? row.upload_created_at.toISOString()
        : row.upload_created_at || "",
    processingRecordRef: row.processing_record_id_ref
      ? {
          id: row.processing_record_id_ref,
          filename: row.processing_record_filename || "",
          reportDate: row.report_date_key || "",
          reportType: row.report_type || "",
          uploadedAt:
            row.processing_record_uploaded_at instanceof Date
              ? row.processing_record_uploaded_at.toISOString()
              : row.processing_record_uploaded_at || "",
        }
      : null,
  };
}

async function updateGeneratedFile(id, patch, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `
      UPDATE ${tables.generatedFiles}
      SET
        processing_record_id = COALESCE($2, processing_record_id),
        download_url = COALESCE($3, download_url),
        view_url = COALESCE($4, view_url),
        storage_provider = COALESCE($5, storage_provider),
        storage_path = COALESCE($6, storage_path),
        file_size_bytes = COALESCE($7, file_size_bytes),
        checksum_sha256 = COALESCE($8, checksum_sha256),
        metadata = COALESCE($9::jsonb, metadata)
      WHERE id = $1
      RETURNING *
    `,
    [
      id,
      patch.processingRecordId || null,
      patch.downloadUrl || null,
      patch.viewUrl || null,
      patch.storageProvider || null,
      patch.storagePath || null,
      patch.fileSizeBytes || null,
      patch.checksumSha256 || null,
      patch.metadata ? JSON.stringify(patch.metadata) : null,
    ],
  );

  return mapGeneratedFile(result.rows[0]);
}

module.exports = {
  createGeneratedFile,
  findSourceUploadByChecksum,
  getGeneratedFileById,
  mapGeneratedFile,
  updateGeneratedFile,
};
