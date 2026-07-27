const pool = require("../../../../db");
const processingRecords = require("../processingRecords");
const printJobRepository = require("../db/printJobRepository");
const { normalizeString } = require("../validators");

async function listProcessingRecords(filters = {}) {
  return processingRecords.listProcessingRecords(filters);
}

async function markPrinted(id, printedBy = "") {
  return processingRecords.markPrinted(id, normalizeString(printedBy));
}

async function markUnprinted(id) {
  return processingRecords.markUnprinted(id);
}

// Mirrors ClaspSCxSeamless's R8 fix: mark-unprinted + create the print_jobs row must commit
// or roll back together, otherwise a failed job-insert can leave the record silently marked
// unprinted with no tracked print request at all.
async function requestPrint(id, options = {}) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const record = await processingRecords.updateProcessingRecord(
      id,
      {
        printed: false,
        lastAction: "print_requested",
      },
      client,
    );

    const job = await printJobRepository.createPrintJob(
      {
        processingRecordId: record.id,
        generatedFileId: (record.metadata && record.metadata.outputFileId) || null,
        requestedBy: normalizeString(options.requestedBy),
        reprintReason: normalizeString(options.reason),
        documentUploadedAt: record.uploadedAt,
      },
      client,
    );

    await client.query("COMMIT");

    return {
      ok: true,
      message: job.isReprint ? "Reprint requested." : "Print requested.",
      record,
      job,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  listProcessingRecords,
  markPrinted,
  markUnprinted,
  requestPrint,
};
