const pool = require("../../../../db");
const { readPharmcareSenderAllowlist } = require("../config");
const { classifyPharmcareEmail, CLASSIFIER_VERSION } = require("./pharmcare/classifier");
const fileStorageService = require("./fileStorageService");
const repository = require("../db/pharmcareRepository");

const PHARMCARE_STORAGE_KIND = "pharmcare-source";
const PDF_MAGIC_BYTES = Buffer.from("%PDF");
// PharmCare invoices/settlement reports are small single-digit-MB PDFs at most; this is a sanity
// ceiling against a corrupt/mislabeled attachment, not a real expected size.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const ACCEPTED_MIME_TYPES = new Set(["application/pdf", "application/x-pdf"]);

function looksLikePdf(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer.subarray(0, 4).equals(PDF_MAGIC_BYTES);
}

// Validates actual bytes (PDF signature) and actual size — the real content, never the filename
// extension alone, per docs/14-pharmcare-sonnet-implementation-plan.md section 4.6/6. Returns
// every applicable reasonCode, not just the first failure, so manual review has full evidence.
//
// Gmail's declared MIME type for an attachment is not a reliable signal of what the file
// actually is: a real PharmCare invoice was observed live reporting application/octet-stream
// while its bytes are a perfectly valid PDF. The magic-byte check above IS the "actual MIME"
// check the docs ask for — a declared-type mismatch is recorded as evidence for the audit trail
// but never rejects an attachment whose bytes are genuinely a PDF.
function validateAttachmentPayload({ buffer, mimeType }) {
  const reasonCodes = [];
  let valid = true;

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    reasonCodes.push("empty_attachment");
    valid = false;
  } else {
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      reasonCodes.push("attachment_too_large");
      valid = false;
    }
    if (!looksLikePdf(buffer)) {
      reasonCodes.push("invalid_pdf_signature");
      valid = false;
    }
  }

  if (mimeType && !ACCEPTED_MIME_TYPES.has(String(mimeType).trim().toLowerCase())) {
    reasonCodes.push("declared_mime_type_mismatch");
  }

  return { reasonCodes, valid };
}

// Stores (or reuses) the attachment's bytes and returns the row it was persisted as. Reuses the
// canonical copy's storage location when an identical (same SHA-256) attachment already exists
// anywhere in the system — the file is never re-uploaded, but a row is still created for THIS
// message so the evidence that it also arrived on this path is not lost.
//
// If writeStoredFile() succeeds but the subsequent createAttachment() insert fails (transaction
// rollback), the uploaded object is orphaned in storage — untracked by any DB row. That is a
// deliberate, safe trade-off: retrying ingestion re-runs classify+store from scratch (nothing in
// the DB references the orphan yet, so canonical-attachment lookup won't find it), which produces
// a second, now-referenced object rather than reusing the orphan. Duplicate DB rows are never
// created either way, and the orphan is safe to garbage-collect later by any storage housekeeping
// job — it just costs a small amount of extra storage until then.
async function storeAttachment({ classifierAttachmentId, filename, mimeType, buffer, messageId }, client) {
  const validation = validateAttachmentPayload({ buffer, mimeType });

  if (!validation.valid) {
    return {
      reasonCodes: validation.reasonCodes,
      row: await repository.createAttachment(
        {
          fileSizeBytes: Buffer.isBuffer(buffer) ? buffer.length : 0,
          gmailAttachmentId: classifierAttachmentId,
          messageId,
          metadata: { invalidReasons: validation.reasonCodes },
          mimeType,
          originalFilename: filename,
          status: "failed",
        },
        client,
      ),
      valid: false,
    };
  }

  const checksumSha256 = fileStorageService.sha256(buffer);
  const canonical = await repository.findCanonicalAttachmentByChecksum(checksumSha256, client);

  if (canonical) {
    const row = await repository.createAttachment(
      {
        checksumSha256,
        duplicateOfAttachmentId: canonical.id,
        fileSizeBytes: buffer.length,
        gmailAttachmentId: classifierAttachmentId,
        messageId,
        metadata: validation.reasonCodes.length ? { validationNotes: validation.reasonCodes } : undefined,
        mimeType,
        originalFilename: filename,
        status: "duplicate",
        storagePath: canonical.storagePath,
        storageProvider: canonical.storageProvider,
      },
      client,
    );
    return { reasonCodes: validation.reasonCodes, row, valid: true };
  }

  const stored = await fileStorageService.writeStoredFile(PHARMCARE_STORAGE_KIND, filename, buffer);
  const row = await repository.createAttachment(
    {
      checksumSha256: stored.checksumSha256,
      fileSizeBytes: stored.fileSizeBytes,
      gmailAttachmentId: classifierAttachmentId,
      messageId,
      metadata: validation.reasonCodes.length ? { validationNotes: validation.reasonCodes } : undefined,
      mimeType,
      originalFilename: filename,
      status: "stored",
      storagePath: stored.storagePath,
      storageProvider: stored.storageProvider,
    },
    client,
  );
  return { reasonCodes: validation.reasonCodes, row, valid: true };
}

// Business dedup for a classified document. Two independent rules apply, checked in order:
//
// 1. Attachment-content dedup (applies to every document type, including MRR/SFR/contract which
//    have no document number): if this document's attachment is a byte-identical duplicate of an
//    earlier one (storeAttachment already resolved that via SHA-256), and the earlier attachment
//    already produced a document of the same type, THIS document is a duplicate of that one too.
// 2. Document-number dedup (currently only CIV e-credit invoices carry a number): same number +
//    same content hash = duplicate of the earlier row; same number + a different hash is an
//    unresolved conflict that must go to manual review, never an automatic overwrite.
async function resolveDocumentDedup(classifiedDocument, attachmentRow, client) {
  if (attachmentRow?.duplicateOfAttachmentId) {
    const canonicalDocuments = await repository.findDocumentsByAttachmentId(
      attachmentRow.duplicateOfAttachmentId,
      client,
    );
    const match = canonicalDocuments.find((doc) => doc.documentType === classifiedDocument.documentType);
    if (match) {
      return {
        duplicateOfDocumentId: match.id,
        reasonCodes: ["attachment_checksum_duplicate"],
        reviewStatus: "duplicate",
      };
    }
  }

  if (!classifiedDocument.documentNumber) {
    return { duplicateOfDocumentId: null, reasonCodes: [], reviewStatus: classifiedDocument.reviewStatus };
  }

  const existing = await repository.findDocumentsByDocumentNumber(classifiedDocument.documentNumber, client);
  if (!existing.length) {
    return { duplicateOfDocumentId: null, reasonCodes: [], reviewStatus: classifiedDocument.reviewStatus };
  }

  const matchingHash = existing.find(
    (doc) => doc.attachmentChecksumSha256 === (attachmentRow?.checksumSha256 || ""),
  );
  if (matchingHash) {
    return {
      duplicateOfDocumentId: matchingHash.id,
      reasonCodes: ["document_number_duplicate"],
      reviewStatus: "duplicate",
    };
  }

  return {
    duplicateOfDocumentId: null,
    reasonCodes: ["document_number_conflict"],
    reviewStatus: "conflict",
  };
}

// Ingests one already-normalized Gmail message DTO (see gmailAdapter.normalizeGmailMessage plus
// downloaded attachment buffers). Idempotent under concurrency: repository.createMessage() uses
// ON CONFLICT (mailbox_account, gmail_message_id) DO NOTHING, so even if two ingestion calls for
// the same message race each other, only one can ever create the row — the loser observes a null
// return, rolls back its own transaction (it hasn't written anything else yet), and reports
// already_ingested. The findMessageByGmailId() check below is only a fast-path that avoids
// opening a transaction for the common re-ingest case; it is not itself what makes this safe.
async function ingestNormalizedMessage(dto, options = {}) {
  const existing = await repository.findMessageByGmailId(dto.mailboxAccount, dto.gmailMessageId);
  if (existing) {
    return { messageId: existing.id, status: "already_ingested" };
  }

  const senderAllowlist = options.senderAllowlist || readPharmcareSenderAllowlist() || undefined;
  const classification = classifyPharmcareEmail(dto, { senderAllowlist });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const message = await repository.createMessage(
      {
        classifierVersion: CLASSIFIER_VERSION,
        gmailMessageId: dto.gmailMessageId,
        gmailThreadId: dto.gmailThreadId || "",
        mailboxAccount: dto.mailboxAccount,
        normalizedSubject: classification.normalizedSubject,
        originalDate: classification.originalDate,
        originalFrom: classification.originalFrom,
        originalSubject: classification.originalSubject,
        rawSubject: dto.rawSubject,
        receivedAt: dto.receivedAt || null,
        route: classification.route,
        status: classification.status,
        visibleCc: dto.visibleCc || "",
        visibleFrom: dto.visibleFrom || "",
        visibleTo: dto.visibleTo || "",
      },
      client,
    );

    if (!message) {
      // Lost the race: another concurrent call already inserted this (mailbox, gmailMessageId).
      // Nothing else has been written in this transaction yet, so a plain rollback is enough.
      await client.query("ROLLBACK");
      const winner = await repository.findMessageByGmailId(dto.mailboxAccount, dto.gmailMessageId);
      return { messageId: winner?.id || null, status: "already_ingested" };
    }

    // Store every downloaded attachment first, keyed by the classifier's attachmentId, so each
    // classified document below can look up the DB attachment row (and its checksum) it belongs to.
    const attachmentRowsById = new Map();
    for (const attachment of dto.attachments || []) {
      const stored = await storeAttachment(
        {
          buffer: attachment.buffer,
          classifierAttachmentId: attachment.attachmentId,
          filename: attachment.filename,
          messageId: message.id,
          mimeType: attachment.mimeType,
        },
        client,
      );
      attachmentRowsById.set(attachment.attachmentId, stored);
    }

    const documents = [];
    for (const classifiedDocument of classification.documents) {
      const storedAttachment = classifiedDocument.attachmentId
        ? attachmentRowsById.get(classifiedDocument.attachmentId)
        : null;
      const attachmentRow = storedAttachment?.row || null;

      let reviewStatus = classifiedDocument.reviewStatus;
      let reasonCodes = classifiedDocument.reasonCodes;
      let duplicateOfDocumentId = null;

      if (storedAttachment && !storedAttachment.valid) {
        reviewStatus = "manual_review";
        reasonCodes = [...reasonCodes, ...(storedAttachment.reasonCodes || ["invalid_pdf_signature"])];
      } else {
        // Carry through any non-blocking evidence from attachment validation (e.g. a declared
        // MIME type that didn't match, even though the PDF signature was valid) so the audit
        // trail shows it even though it didn't affect reviewStatus.
        if (storedAttachment?.reasonCodes?.length) {
          reasonCodes = [...reasonCodes, ...storedAttachment.reasonCodes];
        }
        const dedup = await resolveDocumentDedup(classifiedDocument, attachmentRow, client);
        if (dedup.reviewStatus !== classifiedDocument.reviewStatus) {
          reviewStatus = dedup.reviewStatus;
        }
        reasonCodes = [...reasonCodes, ...dedup.reasonCodes];
        duplicateOfDocumentId = dedup.duplicateOfDocumentId;
      }

      const documentRow = await repository.createDocument(
        {
          attachmentId: attachmentRow?.id || null,
          classifierVersion: CLASSIFIER_VERSION,
          documentNumber: classifiedDocument.documentNumber,
          documentType: classifiedDocument.documentType,
          duplicateOfDocumentId,
          half: classifiedDocument.half,
          messageId: message.id,
          partnerCode: classifiedDocument.partnerCode,
          periodEnd: classifiedDocument.periodEnd,
          periodStart: classifiedDocument.periodStart,
          reasonCodes,
          reviewStatus,
          sourceUrl: classifiedDocument.sourceUrl || null,
        },
        client,
      );
      documents.push(documentRow);
    }

    await client.query("COMMIT");
    return { documents, messageId: message.id, status: "ingested" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { ingestNormalizedMessage, validateAttachmentPayload };
