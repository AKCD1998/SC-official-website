const pool = require("../../../../db");
const printJobRepository = require("../db/printJobRepository");
const processingRecords = require("../processingRecords");
const generatedFileRepository = require("../db/generatedFileRepository");
const { sendPrintNotification } = require("./lineNotifyService");
const { readAutoPrintSince } = require("../config");
const { conflict } = require("../errors");
const { requireString } = require("../validators");

async function resolveDownloadUrl(outputFileId) {
  if (!outputFileId) {
    return "";
  }

  try {
    const generatedFile = await generatedFileRepository.getGeneratedFileById(outputFileId);
    return generatedFile.downloadUrl || "";
  } catch (error) {
    return "";
  }
}

async function getPrintQueue() {
  await printJobRepository.requeueStaleJobs();
  const rows = await printJobRepository.listPrintQueueCandidates(readAutoPrintSince() || null);
  const queue = [];

  for (const row of rows) {
    const record = processingRecords.mapRecord(row);
    const outputFileId = (record.metadata && record.metadata.outputFileId) || "";
    const downloadUrl = await resolveDownloadUrl(outputFileId);
    const preview = await printJobRepository.getAttemptPreview(record.id);

    queue.push({
      processingRecordId: record.id,
      filename: record.filename,
      reportDate: record.reportDate,
      reportType: record.reportType,
      branchCodes: record.branchCodes,
      uploadedAt: record.uploadedAt,
      outputFileId,
      downloadUrl,
      nextAttemptNo: preview.nextAttemptNo,
      isReprint: preview.isReprint,
    });
  }

  return queue;
}

async function createAgentPrintJob(body = {}) {
  const processingRecordId = requireString(body.processingRecordId, "processingRecordId is required.");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Serialize every claim-or-create attempt for this exact record so two concurrent agent
    // requests can never both decide "nothing to claim, create a new job" at the same time
    // (claimQueuedJob's FOR UPDATE SKIP LOCKED alone only prevents claiming the same row twice —
    // it does NOT stop a second caller from falling through to createPrintJob while the first
    // caller still holds the row lock, which produces two separate jobs for one document).
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [processingRecordId]);

    const record = await processingRecords.getProcessingRecordById(processingRecordId, client);

    // Claim an existing unclaimed `queued` row (from request-print or stale-job recovery) if one
    // exists for this record, instead of always inserting a new job — see claimQueuedJob for why.
    const claimed = await printJobRepository.claimQueuedJob(
      processingRecordId,
      {
        agentHost: body.agentHost,
        printerName: body.printerName,
      },
      client,
    );

    if (claimed) {
      await client.query("COMMIT");
      return claimed;
    }

    // Nothing unclaimed to claim — if a concurrent caller serialized just ahead of us already
    // claimed/created an active job for this exact record, WE are the loser of the race. We
    // must not return that job as if it were ours: every caller returning 201 with "the same
    // job" is indistinguishable from success to a print-agent, which has no ownership check
    // of its own — it would proceed to download and physically print regardless of whose
    // agent_host is on the job. So the loser gets an explicit 409 instead, and does not print.
    const activeJobs = await printJobRepository.listActivePrintJobs(processingRecordId, client);

    if (activeJobs.length > 0) {
      // No writes happened on this path — the outer catch's ROLLBACK below is just a clean
      // no-op transaction close, not an undo of anything.
      throw conflict("This document already has an active print job owned by another caller.", {
        existingJobId: activeJobs[0].id,
      });
    }

    const job = await printJobRepository.createPrintJob(
      {
        processingRecordId,
        generatedFileId: body.generatedFileId || (record.metadata && record.metadata.outputFileId) || null,
        agentHost: body.agentHost,
        printerName: body.printerName,
        documentUploadedAt: record.uploadedAt,
      },
      client,
    );

    await client.query("COMMIT");
    return job;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function updateAgentPrintJob(id, patch = {}) {
  return printJobRepository.updatePrintJob(id, patch);
}

async function completeAgentPrintJob(id) {
  const job = await printJobRepository.updatePrintJob(id, {
    status: "completed",
    completedAt: new Date().toISOString(),
  });
  const record = await processingRecords.markPrinted(job.processingRecordId, "auto-print-agent");

  let lineResult;
  try {
    lineResult = await sendPrintNotification(job, record.record || record);
  } catch (error) {
    lineResult = { skipped: true, reason: error.message };
  }

  const notifyPatch = lineResult && lineResult.skipped
    ? { lineNotifyError: lineResult.reason || "skipped" }
    : { lineNotifiedAt: new Date().toISOString() };
  const finalJob = await printJobRepository.updatePrintJob(id, notifyPatch);

  return { ok: true, job: finalJob, record: record.record || record, lineNotify: lineResult };
}

module.exports = {
  completeAgentPrintJob,
  createAgentPrintJob,
  getPrintQueue,
  updateAgentPrintJob,
};
