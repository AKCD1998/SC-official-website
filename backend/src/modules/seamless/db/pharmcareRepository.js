const pool = require("../../../../db");
const { getTables } = require("../tables");
const { notFound } = require("../errors");

function executor(client) {
  return client || pool;
}

function mapMessage(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    mailboxAccount: row.mailbox_account,
    gmailMessageId: row.gmail_message_id,
    gmailThreadId: row.gmail_thread_id || "",
    route: row.route,
    visibleFrom: row.visible_from || "",
    visibleTo: row.visible_to || "",
    visibleCc: row.visible_cc || "",
    rawSubject: row.raw_subject || "",
    normalizedSubject: row.normalized_subject || "",
    originalFrom: row.original_from || "",
    originalSubject: row.original_subject || "",
    originalDate: row.original_date || "",
    receivedAt: row.received_at instanceof Date ? row.received_at.toISOString() : row.received_at,
    ingestedAt: row.ingested_at instanceof Date ? row.ingested_at.toISOString() : row.ingested_at,
    status: row.status,
    classifierVersion: row.classifier_version || "",
    errorCode: row.error_code || "",
    errorMessage: row.error_message || "",
    metadata: row.metadata || {},
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

function mapAttachment(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    messageId: row.message_id,
    gmailAttachmentId: row.gmail_attachment_id,
    originalFilename: row.original_filename,
    mimeType: row.mime_type || "",
    fileSizeBytes: row.file_size_bytes || 0,
    checksumSha256: row.checksum_sha256 || "",
    storageProvider: row.storage_provider,
    storagePath: row.storage_path || "",
    duplicateOfAttachmentId: row.duplicate_of_attachment_id || null,
    status: row.status,
    metadata: row.metadata || {},
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

function mapDocument(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    messageId: row.message_id,
    attachmentId: row.attachment_id || null,
    documentType: row.document_type,
    documentNumber: row.document_number || "",
    partnerCode: row.partner_code || "",
    periodStart: row.period_start
      ? row.period_start instanceof Date
        ? row.period_start.toISOString().slice(0, 10)
        : row.period_start
      : "",
    periodEnd: row.period_end
      ? row.period_end instanceof Date
        ? row.period_end.toISOString().slice(0, 10)
        : row.period_end
      : "",
    half: row.half || "",
    sourceUrl: row.source_url || "",
    reviewStatus: row.review_status,
    duplicateOfDocumentId: row.duplicate_of_document_id || null,
    classifierVersion: row.classifier_version || "",
    reasonCodes: row.reason_codes || [],
    metadata: row.metadata || {},
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

async function findMessageByGmailId(mailboxAccount, gmailMessageId, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `SELECT * FROM ${tables.pharmcareEmailMessages} WHERE mailbox_account = $1 AND gmail_message_id = $2`,
    [mailboxAccount, gmailMessageId],
  );

  return mapMessage(result.rows[0]);
}

async function getMessageById(id, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(`SELECT * FROM ${tables.pharmcareEmailMessages} WHERE id = $1`, [id]);

  if (!result.rows.length) {
    throw notFound(`PharmCare message not found for id: ${id}`);
  }

  return mapMessage(result.rows[0]);
}

async function getAttachmentById(id, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(`SELECT * FROM ${tables.pharmcareEmailAttachments} WHERE id = $1`, [id]);

  if (!result.rows.length) {
    throw notFound(`PharmCare attachment not found for id: ${id}`);
  }

  return mapAttachment(result.rows[0]);
}

async function createMessage(message, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `
      INSERT INTO ${tables.pharmcareEmailMessages} (
        mailbox_account,
        gmail_message_id,
        gmail_thread_id,
        route,
        visible_from,
        visible_to,
        visible_cc,
        raw_subject,
        normalized_subject,
        original_from,
        original_subject,
        original_date,
        received_at,
        status,
        classifier_version,
        error_code,
        error_message,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb)
      ON CONFLICT (mailbox_account, gmail_message_id) DO NOTHING
      RETURNING *
    `,
    [
      message.mailboxAccount,
      message.gmailMessageId,
      message.gmailThreadId || null,
      message.route,
      message.visibleFrom || null,
      message.visibleTo || null,
      message.visibleCc || null,
      message.rawSubject || null,
      message.normalizedSubject || null,
      message.originalFrom || null,
      message.originalSubject || null,
      message.originalDate || null,
      message.receivedAt || null,
      message.status || "manual_review",
      message.classifierVersion || null,
      message.errorCode || null,
      message.errorMessage || null,
      JSON.stringify(message.metadata || {}),
    ],
  );

  // A concurrent insert can win the (mailbox_account, gmail_message_id) unique constraint first —
  // ON CONFLICT DO NOTHING then returns zero rows here rather than erroring. Callers must treat a
  // null return as "someone else just ingested this message" and re-fetch via
  // findMessageByGmailId, never as a real failure.
  return result.rows.length ? mapMessage(result.rows[0]) : null;
}

// Cross-message business dedup: the same PDF legitimately arrives via more than one route
// (gmail filter + a later manual forward), so this looks up the canonical (non-duplicate) stored
// copy by content hash rather than assuming one hash = one row.
async function findCanonicalAttachmentByChecksum(checksumSha256, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `
      SELECT * FROM ${tables.pharmcareEmailAttachments}
      WHERE checksum_sha256 = $1 AND status = 'stored'
      ORDER BY created_at ASC
      LIMIT 1
    `,
    [checksumSha256],
  );

  return mapAttachment(result.rows[0]);
}

async function createAttachment(attachment, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `
      INSERT INTO ${tables.pharmcareEmailAttachments} (
        message_id,
        gmail_attachment_id,
        original_filename,
        mime_type,
        file_size_bytes,
        checksum_sha256,
        storage_provider,
        storage_path,
        duplicate_of_attachment_id,
        status,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
      RETURNING *
    `,
    [
      attachment.messageId,
      attachment.gmailAttachmentId,
      attachment.originalFilename,
      attachment.mimeType || null,
      attachment.fileSizeBytes || null,
      attachment.checksumSha256 || null,
      attachment.storageProvider || "local",
      attachment.storagePath || null,
      attachment.duplicateOfAttachmentId || null,
      attachment.status || "stored",
      JSON.stringify(attachment.metadata || {}),
    ],
  );

  return mapAttachment(result.rows[0]);
}

// Business dedup for documents with a real document number (currently only CIV e-credit
// invoices): same number + same content hash on the linked attachment is a duplicate; same
// number + a different hash is a conflict that must go to manual review, never a silent
// overwrite of the earlier record.
async function findDocumentsByDocumentNumber(documentNumber, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `
      SELECT d.*, a.checksum_sha256
      FROM ${tables.pharmcareDocuments} d
      LEFT JOIN ${tables.pharmcareEmailAttachments} a ON a.id = d.attachment_id
      WHERE d.document_number = $1
      ORDER BY d.created_at ASC
    `,
    [documentNumber],
  );

  return result.rows.map((row) => ({
    ...mapDocument(row),
    attachmentChecksumSha256: row.checksum_sha256 || "",
  }));
}

// Attachment-content dedup (applies to every document type, including MRR/SFR/contract which
// have no document number): looks up documents already created from a given canonical attachment,
// so a hash-duplicate attachment on a later message can be linked to the matching earlier document
// instead of creating a fresh auto_classified row.
async function findDocumentsByAttachmentId(attachmentId, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `SELECT * FROM ${tables.pharmcareDocuments} WHERE attachment_id = $1 ORDER BY created_at ASC`,
    [attachmentId],
  );

  return result.rows.map(mapDocument);
}

async function createDocument(document, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `
      INSERT INTO ${tables.pharmcareDocuments} (
        message_id,
        attachment_id,
        document_type,
        document_number,
        partner_code,
        period_start,
        period_end,
        half,
        source_url,
        review_status,
        duplicate_of_document_id,
        classifier_version,
        reason_codes,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb)
      RETURNING *
    `,
    [
      document.messageId,
      document.attachmentId || null,
      document.documentType,
      document.documentNumber || null,
      document.partnerCode || null,
      document.periodStart || null,
      document.periodEnd || null,
      document.half || null,
      document.sourceUrl || null,
      document.reviewStatus || "auto_classified",
      document.duplicateOfDocumentId || null,
      document.classifierVersion || null,
      JSON.stringify(document.reasonCodes || []),
      JSON.stringify(document.metadata || {}),
    ],
  );

  return mapDocument(result.rows[0]);
}

function decodeCursor(cursor) {
  if (!cursor) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (!decoded || !decoded.createdAt || !decoded.id) {
      return null;
    }
    return decoded;
  } catch (error) {
    return null;
  }
}

// Takes a raw SQL result row (snake_case created_at), not a mapped camelCase document — this is
// called with pageRows straight from the query, before mapDocument() runs.
function encodeCursor(row) {
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
  return Buffer.from(JSON.stringify({ createdAt, id: row.id }), "utf8").toString("base64url");
}

// Document-level inbox listing: one row per classified document (a settlement email with both
// an MRR and an SFR attachment surfaces as two rows), joined back to its parent message so the
// UI can show route/sender/subject without a second round trip.
async function listInboxDocuments(filters = {}, client = null) {
  const db = executor(client);
  const tables = getTables();
  const conditions = [];
  const params = [];

  if (filters.status) {
    params.push(filters.status);
    conditions.push(`d.review_status = $${params.length}`);
  }

  if (filters.documentType) {
    params.push(filters.documentType);
    conditions.push(`d.document_type = $${params.length}`);
  }

  if (filters.duplicate === true) {
    conditions.push(`(d.review_status = 'duplicate' OR d.duplicate_of_document_id IS NOT NULL)`);
  } else if (filters.duplicate === false) {
    conditions.push(`(d.review_status != 'duplicate' AND d.duplicate_of_document_id IS NULL)`);
  }

  const cursor = decodeCursor(filters.cursor);
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    conditions.push(`(d.created_at, d.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Number.isFinite(filters.limit) && filters.limit > 0 ? Math.min(filters.limit, 200) : 50;
  params.push(limit + 1);

  const result = await db.query(
    `
      SELECT
        d.*,
        a.original_filename AS attachment_filename,
        a.checksum_sha256 AS attachment_checksum_sha256,
        m.gmail_message_id,
        m.route,
        m.normalized_subject,
        m.original_from,
        m.original_subject,
        m.received_at,
        m.status AS message_status
      FROM ${tables.pharmcareDocuments} d
      JOIN ${tables.pharmcareEmailMessages} m ON m.id = d.message_id
      LEFT JOIN ${tables.pharmcareEmailAttachments} a ON a.id = d.attachment_id
      ${whereClause}
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $${params.length}
    `,
    params,
  );

  const hasMore = result.rows.length > limit;
  const pageRows = hasMore ? result.rows.slice(0, limit) : result.rows;

  const documents = pageRows.map((row) => ({
    ...mapDocument(row),
    attachmentFilename: row.attachment_filename || "",
    attachmentChecksumSha256: row.attachment_checksum_sha256 || "",
    gmailMessageId: row.gmail_message_id,
    route: row.route,
    normalizedSubject: row.normalized_subject || "",
    originalFrom: row.original_from || "",
    originalSubject: row.original_subject || "",
    receivedAt: row.received_at instanceof Date ? row.received_at.toISOString() : row.received_at,
    messageStatus: row.message_status,
  }));

  return {
    documents,
    nextCursor: hasMore ? encodeCursor(pageRows[pageRows.length - 1]) : null,
  };
}

async function getInboxSummaryCounts(client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `
      SELECT review_status, COUNT(*)::int AS count
      FROM ${tables.pharmcareDocuments}
      GROUP BY review_status
    `,
  );

  const counts = { autoClassified: 0, manualReview: 0, duplicate: 0, conflict: 0 };
  result.rows.forEach((row) => {
    if (row.review_status === "auto_classified") counts.autoClassified = row.count;
    if (row.review_status === "manual_review") counts.manualReview = row.count;
    if (row.review_status === "duplicate") counts.duplicate = row.count;
    if (row.review_status === "conflict") counts.conflict = row.count;
  });

  return counts;
}

async function getMessageWithEvidence(id, client = null) {
  const message = await getMessageById(id, client);
  const db = executor(client);
  const tables = getTables();

  const attachmentsResult = await db.query(
    `SELECT * FROM ${tables.pharmcareEmailAttachments} WHERE message_id = $1 ORDER BY created_at ASC`,
    [id],
  );
  const documentsResult = await db.query(
    `SELECT * FROM ${tables.pharmcareDocuments} WHERE message_id = $1 ORDER BY created_at ASC`,
    [id],
  );

  return {
    ...message,
    attachments: attachmentsResult.rows.map(mapAttachment),
    documents: documentsResult.rows.map(mapDocument),
  };
}

async function getSyncState(mailboxAccount, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `SELECT * FROM ${tables.pharmcareSyncState} WHERE mailbox_account = $1`,
    [mailboxAccount],
  );

  const row = result.rows[0];
  if (!row) {
    return { checkpoint: {}, lastRunStatus: null };
  }

  return {
    checkpoint: row.checkpoint || {},
    lastRunFinishedAt: row.last_run_finished_at instanceof Date ? row.last_run_finished_at.toISOString() : row.last_run_finished_at,
    lastRunStartedAt: row.last_run_started_at instanceof Date ? row.last_run_started_at.toISOString() : row.last_run_started_at,
    lastRunStatus: row.last_run_status || null,
  };
}

async function saveSyncState(mailboxAccount, { checkpoint, lastRunStatus }, client = null) {
  const db = executor(client);
  const tables = getTables();
  const finishedAt = lastRunStatus ? new Date() : null;
  await db.query(
    `
      INSERT INTO ${tables.pharmcareSyncState} (mailbox_account, checkpoint, last_run_status, last_run_finished_at)
      VALUES ($1, $2::jsonb, $3, $4)
      ON CONFLICT (mailbox_account) DO UPDATE SET
        checkpoint = EXCLUDED.checkpoint,
        last_run_status = EXCLUDED.last_run_status,
        last_run_finished_at = EXCLUDED.last_run_finished_at,
        updated_at = now()
    `,
    [mailboxAccount, JSON.stringify(checkpoint || {}), lastRunStatus || null, finishedAt],
  );
}

async function markSyncRunStarted(mailboxAccount, runKind, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `INSERT INTO ${tables.pharmcareSyncRuns} (mailbox_account, run_kind, status) VALUES ($1, $2, 'running') RETURNING id`,
    [mailboxAccount, runKind],
  );
  return result.rows[0].id;
}

async function markSyncRunFinished(runId, { status, messageCount, outcomeCounts, errors, checkpoint }, client = null) {
  const db = executor(client);
  const tables = getTables();
  await db.query(
    `
      UPDATE ${tables.pharmcareSyncRuns}
      SET finished_at = now(),
          status = $2,
          message_count = $3,
          outcome_counts = $4::jsonb,
          errors = $5::jsonb,
          checkpoint = $6::jsonb
      WHERE id = $1
    `,
    [
      runId,
      status,
      messageCount || 0,
      JSON.stringify(outcomeCounts || {}),
      JSON.stringify(errors || []),
      JSON.stringify(checkpoint || {}),
    ],
  );
}

async function listRecentSyncRuns(mailboxAccount, limit = 10, client = null) {
  const db = executor(client);
  const tables = getTables();
  const result = await db.query(
    `SELECT * FROM ${tables.pharmcareSyncRuns} WHERE mailbox_account = $1 ORDER BY started_at DESC LIMIT $2`,
    [mailboxAccount, limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    runKind: row.run_kind,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
    finishedAt: row.finished_at instanceof Date ? row.finished_at.toISOString() : row.finished_at,
    status: row.status,
    messageCount: row.message_count,
    outcomeCounts: row.outcome_counts || {},
    errors: row.errors || [],
  }));
}

module.exports = {
  createAttachment,
  createDocument,
  createMessage,
  findCanonicalAttachmentByChecksum,
  findDocumentsByAttachmentId,
  findDocumentsByDocumentNumber,
  findMessageByGmailId,
  getAttachmentById,
  getInboxSummaryCounts,
  getMessageById,
  getMessageWithEvidence,
  getSyncState,
  listInboxDocuments,
  listRecentSyncRuns,
  mapAttachment,
  mapDocument,
  mapMessage,
  markSyncRunFinished,
  markSyncRunStarted,
  saveSyncState,
};
