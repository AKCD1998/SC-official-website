const pool = require("../../../../db");
const { getTables } = require("../tables");

function executor(client) {
  return client || pool;
}

async function createPreviewSheet(sheet, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `
      INSERT INTO ${tables.previewSheets} (
        preview_file_id,
        upload_id,
        processing_record_id,
        sheet_name,
        sheet_order,
        legacy_sheet_id,
        legacy_spreadsheet_id,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      RETURNING *
    `,
    [
      sheet.previewFileId,
      sheet.uploadId || null,
      sheet.processingRecordId || null,
      sheet.sheetName,
      sheet.sheetOrder,
      sheet.legacySheetId || null,
      sheet.legacySpreadsheetId || null,
      JSON.stringify(sheet.metadata || {}),
    ],
  );

  return result.rows[0];
}

async function listPreviewSheets(previewFileId, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `SELECT * FROM ${tables.previewSheets} WHERE preview_file_id = $1 ORDER BY sheet_order`,
    [previewFileId],
  );

  return result.rows;
}

module.exports = { createPreviewSheet, listPreviewSheets };
