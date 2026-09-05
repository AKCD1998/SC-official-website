const pool = require("../../../../db");
const printJobRepository = require("../db/printJobRepository");
const processingRecords = require("../processingRecords");
const generatedFileRepository = require("../db/generatedFileRepository");
const { sendPrintNotification } = require("./lineNotifyService");
const { sendGeneratedFileEmail } = require("./emailService");
const { readStoredFile } = require("./fileStorageService");
const { readAutoPrintSince, readEmailConfig } = require("../config");
const { conflict } = require("../errors");
const { requireString } = require("../validators");
const { getTables } = require("../tables");
const { LANE_LOCK } = require("./accountingOriginalPrintService");

async function batchHoldsPrinter(client = pool) {
  if (process.env.SEAMLESS_ACCOUNTING_BATCH_ENABLED !== "true") return false;
  const t = getTables();
  const result = await client.query("SELECT id FROM " + t.accountingPrintBatches +
    " WHERE status IN ('queued','printing','paused') LIMIT 1");
  return result.rows.length > 0;
}

// metadata.outputFileId is only ever set by the real upload->process pipeline — records
// imported from the legacy ProcessingRegistry never had it populated, so this falls back to
// generated_files.processing_record_id (see findLatestPrintableFileByProcessingRecordId) rather
// than sending an empty downloadUrl to the print-agent, which fails with "Failed to parse URL
// from" when it tries to fetch it.
async function resolveOutputFile(record) {
  const metadataOutputFileId = (record.metadata && record.metadata.outputFileId) || "";

  if (metadataOutputFileId) {
    try {
      const generatedFile = await generatedFileRepository.getGeneratedFileById(metadataOutputFileId);
      return { outputFileId: generatedFile.id, downloadUrl: generatedFile.downloadUrl || "" };
    } catch (error) {
      // fall through to the processing_record_id lookup below
    }
  }

  const fallback = await generatedFileRepository.findLatestPrintableFileByProcessingRecordId(record.id);
  if (!fallback) {
    return { outputFileId: "", downloadUrl: "" };
  }

  return { outputFileId: fallback.id, downloadUrl: fallback.downloadUrl || "" };
}

async function getPrintQueue() {
  if (await batchHoldsPrinter()) return [];
  await printJobRepository.requeueStaleJobs();
  const rows = await printJobRepository.listPrintQueueCandidates(readAutoPrintSince() || null);
  const queue = [];

  for (const row of rows) {
    const record = processingRecords.mapRecord(row);
    const { outputFileId, downloadUrl } = await resolveOutputFile(record);
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
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [LANE_LOCK]);
    if (await batchHoldsPrinter(client)) throw conflict("ชุดเอกสารบัญชีกำลังใช้เครื่องพิมพ์");

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

    let generatedFileId = body.generatedFileId || (record.metadata && record.metadata.outputFileId) || null;
    if (!generatedFileId) {
      // Legacy ProcessingRegistry imports never had metadata.outputFileId set — fall back to the
      // processing_record_id FK so these records can still be printed (see resolveOutputFile).
      const fallback = await generatedFileRepository.findLatestPrintableFileByProcessingRecordId(
        processingRecordId,
        client,
      );
      generatedFileId = fallback ? fallback.id : null;
    }

    const job = await printJobRepository.createPrintJob(
      {
        processingRecordId,
        generatedFileId,
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

async function sendPrintEmailNotification(job, record) {
  const emailConfig = readEmailConfig();

  const providerConfigured = emailConfig.provider === "brevo" ? emailConfig.brevoApiKey : emailConfig.sendgridApiKey;
  if (!providerConfigured || !emailConfig.mailFrom || !emailConfig.docsRecipientEmail) {
    return {
      skipped: true,
      reason: "Email provider credentials, MAIL_USER, or SEAMLESS_DOCS_RECIPIENT_EMAIL is not configured.",
    };
  }

  let outputFileId = job.generatedFileId || (record.metadata && record.metadata.outputFileId);

  if (!outputFileId) {
    // Print jobs created before this fallback existed may still have a null generated_file_id
    // for legacy ProcessingRegistry imports — same fallback as resolveOutputFile/createAgentPrintJob.
    const fallback = await generatedFileRepository.findLatestPrintableFileByProcessingRecordId(record.id);
    outputFileId = fallback ? fallback.id : "";
  }

  if (!outputFileId) {
    return { skipped: true, reason: "No output file recorded on this print job." };
  }

  const generatedFile = await generatedFileRepository.getGeneratedFileById(outputFileId);
  const bucket = generatedFile.metadata?.storageBucket || undefined;
  const buffer = await readStoredFile(generatedFile.storageProvider, generatedFile.storagePath, bucket);

  // Same recipient/provider as every other print — only the subject prefix tells PharmCare and
  // Seamless mail apart at a glance in an inbox list (no HTML template exists for either today,
  // see docs/22-pharmcare-print-integration-spec.md for why that's out of scope here).
  const isPharmcare = record.metadata?.source === "pharmcare";
  const subjectPrefix = isPharmcare ? "[PharmCare]" : "[ClaspSCxSeamless]";

  await sendGeneratedFileEmail({
    to: emailConfig.docsRecipientEmail,
    subject: `${subjectPrefix} ปริ้นเอกสารส่งพี่เอแล้ว: ${record.filename}`,
    text: `ไฟล์ ${record.filename} ปริ้นเสร็จแล้วที่เครื่อง ${job.agentHost || "-"} (${job.printerName || "-"})`,
    filename: generatedFile.filename,
    mimeType: generatedFile.mimeType,
    buffer,
  });

  return { skipped: false };
}

async function completeAgentPrintJob(id) {
  const job = await printJobRepository.updatePrintJob(id, {
    status: "completed",
    completedAt: new Date().toISOString(),
  });
  const record = await processingRecords.markPrinted(job.processingRecordId, "auto-print-agent");
  const notifyRecord = record.record || record;

  let lineResult;
  try {
    lineResult = await sendPrintNotification(job, notifyRecord);
  } catch (error) {
    lineResult = { skipped: true, reason: error.message };
  }

  let emailResult;
  try {
    emailResult = await sendPrintEmailNotification(job, notifyRecord);
  } catch (error) {
    emailResult = { skipped: true, reason: error.message };
  }

  if (emailResult.skipped) {
    // Surfaced through listProcessingRecords -> the history dashboard, per the accountant-facing
    // requirement that a failed automatic email must be visible somewhere, not just a silent DB
    // field nobody looks at (unlike the pre-existing LINE-only lineNotifyError column).
    console.error(`[printAgentService] email notify for print job ${id} was skipped: ${emailResult.reason}`);
  }

  const notifyPatch = {
    ...(lineResult && lineResult.skipped
      ? { lineNotifyError: lineResult.reason || "skipped" }
      : { lineNotifiedAt: new Date().toISOString() }),
    ...(emailResult && emailResult.skipped
      ? { emailNotifyError: emailResult.reason || "skipped" }
      : { emailNotifiedAt: new Date().toISOString() }),
  };
  const finalJob = await printJobRepository.updatePrintJob(id, notifyPatch);

  return {
    ok: true,
    job: finalJob,
    record: notifyRecord,
    lineNotify: lineResult,
    emailNotify: emailResult,
  };
}

module.exports = {
  completeAgentPrintJob,
  createAgentPrintJob,
  getPrintQueue,
  updateAgentPrintJob,
};
