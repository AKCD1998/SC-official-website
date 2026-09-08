const crypto = require("node:crypto");
const pool = require("../../../../db");
const processingRecords = require("../processingRecords");
const generatedFileRepository = require("../db/generatedFileRepository");
const printJobRepository = require("../db/printJobRepository");
const { listOperationLogsForRecord, logOperation } = require("../db/operationLogRepository");
const { readEmailConfig, readLineConfig, readR2Config } = require("../config");
const { badRequest, conflict, notFound, serviceUnavailable } = require("../errors");
const { normalizeLimit, normalizeString } = require("../validators");
const r2Storage = require("./r2StorageService");
const { buildApiUrl, readStoredFile, sha256, writeStoredFile } = require("./fileStorageService");
const { sendGeneratedFileEmail } = require("./emailService");
const { sendLineMessage } = require("./lineNotifyService");
const { inspectExpenseReceiptWorkbook } = require("./expenseReceiptWorkbookService");
const {
  buildExpenseReceiptPrintOrderEmail,
  buildExpenseReceiptPrintOrderLineMessage,
} = require("./expenseReceiptNotificationService");

const SOURCE = "expense_receipt";
const DOCUMENT_TYPE = "expense_receipt";
const PRINT_APPROVAL_CONFIRMATION = "APPROVE_PRINT";
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function requireExpensePeriod(value) {
  const period = normalizeString(value);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    throw badRequest("expensePeriod must use YYYY-MM format.");
  }
  return period;
}

function periodEndKey(expensePeriod) {
  const [year, month] = requireExpensePeriod(expensePeriod).split("-").map(Number);
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
}

function emailProviderReady(config) {
  const providerKey = config.provider === "brevo" ? config.brevoApiKey : config.sendgridApiKey;
  return ["brevo", "sendgrid"].includes(config.provider) && !!providerKey;
}

function getExpenseReceiptPreflight() {
  const line = readLineConfig();
  const email = readEmailConfig();
  const r2 = readR2Config();
  const storageReady = !!(
    r2Storage.r2Configured && r2.endpoint && r2.accessKeyId && r2.secretAccessKey && r2.bucket
  );
  const lineReady = !!(line.channelAccessToken && line.targetId);
  const emailReady = !!(emailProviderReady(email) && email.mailFrom && email.docsRecipientEmail);

  return {
    ready: storageReady && lineReady && emailReady,
    storage: { ready: storageReady, provider: "r2", bucketConfigured: !!r2.bucket },
    notifications: {
      line: { ready: lineReady, targetConfigured: !!line.targetId },
      email: { ready: emailReady, provider: email.provider, recipientConfigured: !!email.docsRecipientEmail },
    },
    print: { queued: false, requiresFinalApproval: true, confirmation: PRINT_APPROVAL_CONFIRMATION },
  };
}

function trackingCode(expensePeriod) {
  return `ER-${expensePeriod.replace("-", "")}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function publicGeneratedFile(file) {
  return {
    id: file.id,
    processingRecordId: file.processingRecordId,
    fileKind: file.fileKind,
    filename: file.filename,
    mimeType: file.mimeType,
    fileSizeBytes: file.fileSizeBytes,
    downloadUrl: file.downloadUrl,
    createdAt: file.createdAt,
  };
}

function notificationComplete(notifications = {}) {
  return notifications.line?.status === "sent" && notifications.email?.status === "sent";
}

function deliveryFailure(error) {
  return String(error && error.message ? error.message : error || "Delivery failed.").slice(0, 1000);
}

async function sendPrintOrderNotifications({ record, file, buffer, channels = ["line", "email"] }) {
  const emailConfig = readEmailConfig();
  const lineMessage = buildExpenseReceiptPrintOrderLineMessage(record);
  const email = buildExpenseReceiptPrintOrderEmail(record, { downloadUrl: file.downloadUrl });
  const sentAt = () => new Date().toISOString();
  const tasks = {
    line: () => sendLineMessage(lineMessage),
    email: () => sendGeneratedFileEmail({
      to: emailConfig.docsRecipientEmail,
      subject: email.subject,
      text: email.text,
      filename: file.filename,
      mimeType: file.mimeType || XLSX_MIME_TYPE,
      buffer,
    }),
  };
  const selected = channels.filter((channel) => tasks[channel]);
  const settled = await Promise.allSettled(selected.map((channel) => tasks[channel]()));
  return Object.fromEntries(selected.map((channel, index) => {
    const result = settled[index];
    if (result.status === "fulfilled" && !result.value?.skipped) {
      return [channel, {
        status: "sent",
        sentAt: sentAt(),
        error: "",
        ...(channel === "email" ? { recipient: emailConfig.docsRecipientEmail } : {}),
      }];
    }
    return [channel, {
      status: "failed",
      sentAt: "",
      error: deliveryFailure(result.status === "rejected" ? result.reason : result.value?.reason),
      ...(channel === "email" ? { recipient: emailConfig.docsRecipientEmail } : {}),
    }];
  }));
}

async function updatePrintOrderNotificationState(record, patch, actor, client = null) {
  const notifications = { ...(record.metadata.notifications || {}), ...patch };
  const complete = notificationComplete(notifications);
  const updated = await processingRecords.updateProcessingRecord(record.id, {
    lastAction: complete ? "expense_receipt_print_notifications_sent" : "expense_receipt_print_notification_failed",
    metadata: {
      ...record.metadata,
      notifications,
      workflowStatus: complete ? "print_notifications_sent" : "print_notification_failed",
    },
  }, client);

  await Promise.all(Object.entries(patch).map(([channel, result]) => logOperation({
    scope: SOURCE,
    level: result.status === "sent" ? "INFO" : "ERROR",
    action: `expense_receipt_print_${channel}_${result.status}`,
    message: `${channel.toUpperCase()} print-order notification ${result.status} for ${record.metadata.trackingCode}.`,
    actor,
    processingRecordId: record.id,
    generatedFileId: record.metadata.outputFileId || null,
    metadata: { channel, status: result.status, error: result.error || "" },
  }, client)));
  return updated;
}

async function submitExpenseReceipt({ file, expensePeriod, expectedClaimantName, submittedBy }) {
  if (!file || !Buffer.isBuffer(file.buffer)) throw badRequest("An .xlsx file is required.");
  const originalFilename = normalizeString(file.originalname);
  if (!originalFilename.toLowerCase().endsWith(".xlsx")) {
    throw badRequest("Only .xlsx expense receipts are accepted.");
  }
  const period = requireExpensePeriod(expensePeriod);
  const inspection = await inspectExpenseReceiptWorkbook(file.buffer, {
    expensePeriod: period,
    expectedClaimantName,
  });
  const preflight = getExpenseReceiptPreflight();
  if (!preflight.ready) {
    throw serviceUnavailable("Expense receipt submission is not fully configured.", { preflight });
  }

  const checksumSha256 = sha256(file.buffer);
  const actor = normalizeString(submittedBy) || "admin";
  const client = await pool.connect();
  let record;
  let printableFile;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`expense-receipt:${checksumSha256}`]);
    const duplicate = await generatedFileRepository.findSourceUploadByChecksum(checksumSha256, {}, client);
    if (duplicate) {
      throw conflict("This expense receipt was already submitted.", {
        code: "DUPLICATE_EXPENSE_RECEIPT",
        existingGeneratedFileId: duplicate.id,
        existingProcessingRecord: duplicate.processingRecordRef,
      });
    }

    const stored = await writeStoredFile("expense_receipt", originalFilename, file.buffer);
    if (stored.storageProvider !== "r2") {
      throw serviceUnavailable("Expense receipts require durable R2 storage.");
    }

    const code = trackingCode(period);
    record = await processingRecords.createProcessingRecord({
      reportDate: periodEndKey(period),
      reportType: "individual",
      filename: originalFilename,
      sourceUploadName: originalFilename,
      uploadedAt: new Date().toISOString(),
      uploadedBy: actor,
      printed: false,
      lastAction: "expense_receipt_stored",
      notes: `ใบสำคัญรับเงิน ${inspection.claimantName} ${period}`,
      metadata: {
        source: SOURCE,
        documentType: DOCUMENT_TYPE,
        trackingCode: code,
        expensePeriod: period,
        claimantName: inspection.claimantName,
        payerName: inspection.payerName,
        totalAmount: inspection.totalAmount,
        amountInWords: inspection.amountInWords,
        itemCount: inspection.itemCount,
        documentDate: inspection.documentDate,
        firstExpenseDate: inspection.firstExpenseDate,
        lastExpenseDate: inspection.lastExpenseDate,
        warnings: inspection.warnings,
        workflowStatus: "stored_pending_final_approval",
        notifications: { line: { status: "not_sent" }, email: { status: "not_sent" } },
        printApproval: null,
      },
    }, client);

    const fileMetadata = {
      source: SOURCE,
      documentType: DOCUMENT_TYPE,
      trackingCode: code,
      storageBucket: stored.storageBucket,
      originalFilename,
    };
    await generatedFileRepository.createGeneratedFile({
      processingRecordId: record.id,
      fileKind: "source_upload",
      filename: originalFilename,
      mimeType: file.mimetype || XLSX_MIME_TYPE,
      storageProvider: stored.storageProvider,
      storagePath: stored.storagePath,
      fileSizeBytes: stored.fileSizeBytes,
      checksumSha256,
      metadata: fileMetadata,
    }, client);
    printableFile = await generatedFileRepository.createGeneratedFile({
      processingRecordId: record.id,
      fileKind: "processed_xlsx",
      filename: originalFilename,
      mimeType: file.mimetype || XLSX_MIME_TYPE,
      storageProvider: stored.storageProvider,
      storagePath: stored.storagePath,
      fileSizeBytes: stored.fileSizeBytes,
      checksumSha256,
      metadata: { ...fileMetadata, byteIdenticalToSource: true },
    }, client);
    const downloadUrl = buildApiUrl(`/api/files/${printableFile.id}/download`);
    printableFile = await generatedFileRepository.updateGeneratedFile(printableFile.id, {
      downloadUrl,
      viewUrl: downloadUrl,
    }, client);
    record = await processingRecords.updateProcessingRecord(record.id, {
      metadata: { ...record.metadata, outputFileId: printableFile.id, outputDownloadUrl: downloadUrl },
    }, client);
    await logOperation({
      scope: SOURCE,
      action: "expense_receipt_stored",
      message: `Stored expense receipt ${code} in R2; print remains unapproved.`,
      actor,
      processingRecordId: record.id,
      generatedFileId: printableFile.id,
      metadata: { trackingCode: code, checksumSha256, warnings: inspection.warnings },
    }, client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return {
    ok: true,
    record,
    file: publicGeneratedFile(printableFile),
    inspection,
    notifications: record.metadata.notifications,
    readyForPrintApproval: true,
    printQueued: false,
  };
}

async function assertExpenseReceiptRecord(id, client = null) {
  const record = await processingRecords.getProcessingRecordById(id, client);
  if (record.metadata?.source !== SOURCE || record.metadata?.documentType !== DOCUMENT_TYPE) {
    throw notFound(`Expense receipt not found for id: ${id}`);
  }
  return record;
}

async function listExpenseReceipts(filters = {}) {
  return processingRecords.listProcessingRecords({
    source: SOURCE,
    documentType: DOCUMENT_TYPE,
    limit: normalizeLimit(filters.limit, 100),
    printed: filters.printed,
  });
}

async function getExpenseReceipt(id) {
  const record = await assertExpenseReceiptRecord(id);
  const [files, printJobs, events] = await Promise.all([
    generatedFileRepository.listGeneratedFilesByProcessingRecordId(record.id),
    printJobRepository.listPrintJobsForRecord(record.id),
    listOperationLogsForRecord(record.id, 200),
  ]);
  return { record, files: files.map(publicGeneratedFile), printJobs, events };
}

async function approveExpenseReceiptPrint(id, options = {}) {
  if (normalizeString(options.confirmation) !== PRINT_APPROVAL_CONFIRMATION) {
    throw badRequest(`confirmation must be exactly ${PRINT_APPROVAL_CONFIRMATION}.`);
  }
  const approvedBy = normalizeString(options.approvedBy);
  if (!approvedBy) throw badRequest("A named authenticated approver is required.");
  const preflight = getExpenseReceiptPreflight();
  if (!preflight.ready) {
    throw serviceUnavailable("Print, LINE, and email cannot be released together because configuration is incomplete.", {
      preflight,
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`expense-receipt-approval:${id}`]);
    let record = await assertExpenseReceiptRecord(id, client);
    if (record.metadata.printApproval?.approvedAt) {
      throw conflict("This expense receipt already has final print approval.", record.metadata.printApproval);
    }
    const activeJobs = await printJobRepository.listActivePrintJobs(record.id, client);
    if (activeJobs.length) {
      throw conflict("This expense receipt already has an active print job.", { printJobId: activeJobs[0].id });
    }

    const file = await generatedFileRepository.getGeneratedFileById(record.metadata.outputFileId, client);
    const bucket = file.metadata?.storageBucket || undefined;
    const buffer = await readStoredFile(file.storageProvider, file.storagePath, bucket);
    const pendingChannels = ["line", "email"].filter(
      (channel) => record.metadata.notifications?.[channel]?.status !== "sent",
    );
    if (pendingChannels.length) {
      const notificationPatch = await sendPrintOrderNotifications({
        record,
        file,
        buffer,
        channels: pendingChannels,
      });
      record = await updatePrintOrderNotificationState(record, notificationPatch, approvedBy, client);
    }
    if (!notificationComplete(record.metadata.notifications)) {
      await client.query("COMMIT");
      return {
        ok: false,
        record,
        notifications: record.metadata.notifications,
        printQueued: false,
        message: "LINE and Gmail were not both delivered, so no print job was released.",
      };
    }

    const approvedAt = new Date().toISOString();
    const job = await printJobRepository.createPrintJob({
      processingRecordId: record.id,
      generatedFileId: record.metadata.outputFileId || null,
      requestedBy: approvedBy,
      documentUploadedAt: record.uploadedAt,
      metadata: { source: SOURCE, approvalRequired: true, approvedAt, approvedBy },
    }, client);
    record = await processingRecords.updateProcessingRecord(record.id, {
      printed: false,
      lastAction: "expense_receipt_print_approved",
      metadata: {
        ...record.metadata,
        workflowStatus: "print_approved_queued",
        printApproval: {
          approvedAt,
          approvedBy,
          authSource: normalizeString(options.authSource),
          confirmation: PRINT_APPROVAL_CONFIRMATION,
          printJobId: job.id,
        },
      },
    }, client);
    await logOperation({
      scope: SOURCE,
      action: "expense_receipt_print_approved",
      message: `Final print approval recorded for ${record.metadata.trackingCode}.`,
      actor: approvedBy,
      processingRecordId: record.id,
      generatedFileId: record.metadata.outputFileId || null,
      metadata: { approvedAt, printJobId: job.id, targetBranch: "000", authSource: options.authSource },
    }, client);
    await client.query("COMMIT");
    return {
      ok: true,
      record,
      notifications: record.metadata.notifications,
      printJob: job,
      printQueued: true,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  DOCUMENT_TYPE,
  PRINT_APPROVAL_CONFIRMATION,
  SOURCE,
  approveExpenseReceiptPrint,
  getExpenseReceipt,
  getExpenseReceiptPreflight,
  listExpenseReceipts,
  periodEndKey,
  submitExpenseReceipt,
};
