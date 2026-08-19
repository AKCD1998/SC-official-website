const pool = require("../../../../db");
const { getTables } = require("../tables");
const { badRequest, notFound } = require("../errors");
const generatedFileRepository = require("../db/generatedFileRepository");
const processingRecords = require("../processingRecords");
const processingRecordAppService = require("./processingRecordAppService");
const { buildApiUrl } = require("./fileStorageService");

// Lets a PharmCare document ride the exact same print pipeline Seamless documents already use
// (print-agent polling, print_jobs queue, LINE/email notifications on completion) without any
// change to that pipeline: a PharmCare "ขอปริ้น" click creates a normal processing_records +
// generated_files pair — tagged metadata.source = 'pharmcare' — pointing at the SAME storage
// object the PharmCare attachment already owns (no file is copied or moved). See
// docs/22-pharmcare-print-integration-spec.md for the full design writeup.
//
// pharmcareRepository.js is under active concurrent edit by another workstream as this is
// written (see docs/18) — this file deliberately queries pharmcare_documents/
// pharmcare_email_attachments directly instead of importing from it, to avoid touching that
// file at all.

function executor(client) {
  return client || pool;
}

async function getPrintableDocument(documentId, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `
      SELECT
        d.id,
        d.message_id,
        d.document_type,
        d.document_number,
        a.id AS attachment_id,
        a.original_filename,
        a.mime_type,
        a.storage_provider,
        a.storage_path
      FROM ${tables.pharmcareDocuments} d
      LEFT JOIN ${tables.pharmcareEmailAttachments} a ON a.id = d.attachment_id
      WHERE d.id = $1
    `,
    [documentId],
  );

  if (!result.rows.length) {
    throw notFound(`PharmCare document not found for id: ${documentId}`);
  }

  const row = result.rows[0];

  if (!row.attachment_id || !row.storage_path) {
    throw badRequest(
      "This document has no stored PDF to print (e.g. a receipt/tax-invoice link with no attachment).",
    );
  }

  return {
    id: row.id,
    messageId: row.message_id,
    documentType: row.document_type,
    documentNumber: row.document_number || "",
    originalFilename: row.original_filename,
    mimeType: row.mime_type || "application/pdf",
    storageProvider: row.storage_provider,
    storagePath: row.storage_path,
  };
}

async function findExistingProcessingRecordId(pharmcareDocumentId, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `SELECT id FROM ${tables.processingRecords} WHERE metadata->>'pharmcareDocumentId' = $1 LIMIT 1`,
    [pharmcareDocumentId],
  );
  return result.rows.length ? result.rows[0].id : null;
}

// Idempotent per PharmCare document: a second "ขอปริ้น" click (or a reprint) reuses the same
// processing_records/generated_files pair instead of creating a new one every time — the
// resulting record then goes through the normal reprint path (processingRecordAppService.
// requestPrint already handles "this record was printed before" via print_jobs' isReprint
// flag, same as Seamless's own reprint button).
async function ensurePrintableRecord(document) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    // Serializes concurrent "ขอปริ้น" clicks on the same document so two callers can't both
    // decide "nothing exists yet" and create two separate record/file pairs for one document —
    // mirrors the advisory-lock pattern printAgentService.createAgentPrintJob uses.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`pharmcare-print:${document.id}`]);

    const existingId = await findExistingProcessingRecordId(document.id, client);
    if (existingId) {
      const record = await processingRecords.getProcessingRecordById(existingId, client);
      await client.query("COMMIT");
      return record;
    }

    const generatedFile = await generatedFileRepository.createGeneratedFile(
      {
        fileKind: "pharmcare_document",
        filename: document.originalFilename,
        mimeType: document.mimeType,
        storageProvider: document.storageProvider,
        storagePath: document.storagePath,
        metadata: { source: "pharmcare", pharmcareDocumentId: document.id },
      },
      client,
    );

    // downloadUrl embeds the row's own id, which only exists after the insert above — the
    // print-agent and email notification both read generatedFile.downloadUrl directly (see
    // printAgentService.resolveOutputFile / sendPrintEmailNotification), so this must be a real,
    // working /api/files/:id/download URL before anything tries to use this record.
    const tables = getTables();
    await client.query(`UPDATE ${tables.generatedFiles} SET download_url = $1 WHERE id = $2`, [
      buildApiUrl(`/api/files/${generatedFile.id}/download`),
      generatedFile.id,
    ]);

    const record = await processingRecords.createProcessingRecord(
      {
        filename: document.originalFilename,
        // report_type is a constrained enum (individual/summary/shopee — see validators.js
        // parseFormatterMode) that PharmCare documents don't semantically belong to; "individual"
        // is the closest fit (one document, not a summary/batch). The real discriminator for
        // "this came from PharmCare" is metadata.source below, not this field.
        reportType: "individual",
        sourceUploadName: document.originalFilename,
        uploadedAt: new Date().toISOString(),
        metadata: {
          source: "pharmcare",
          pharmcareDocumentId: document.id,
          pharmcareMessageId: document.messageId,
          pharmcareDocumentType: document.documentType,
          pharmcareDocumentNumber: document.documentNumber,
          outputFileId: generatedFile.id,
        },
      },
      client,
    );

    await client.query("COMMIT");
    return record;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function requestPharmcarePrint(documentId, options = {}) {
  const document = await getPrintableDocument(documentId);
  const record = await ensurePrintableRecord(document);
  return processingRecordAppService.requestPrint(record.id, options);
}

module.exports = { requestPharmcarePrint };
