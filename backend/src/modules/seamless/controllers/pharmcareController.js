const repository = require("../db/pharmcareRepository");
const { createStoredFileStream } = require("../services/fileStorageService");
const { badRequest, notFound } = require("../errors");

const VALID_REVIEW_STATUSES = ["auto_classified", "manual_review", "duplicate", "conflict"];
const VALID_DOCUMENT_TYPES = [
  "e_credit_invoice",
  "settlement_mrr",
  "settlement_sfr",
  "receipt_link_pending",
  "contract",
  "unknown",
];

function parseDuplicateFilter(value) {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw badRequest("duplicate filter must be 'true' or 'false'.");
}

function parseLimit(value) {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw badRequest("limit must be a positive number.");
  }
  return parsed;
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// V8 happily rolls impossible ISO dates forward (2026-02-31 → March 3) instead of rejecting
// them, so verify the day actually exists by round-tripping through Date.UTC.
function isValidCalendarDate(dateStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

// Inbox users pick calendar dates (YYYY-MM-DD) in ICT (+07:00 — no DST). Convert each pick to an
// ICT-midnight timestamp so a picked day means the user's calendar day, not the server's UTC
// day. receivedTo becomes an exclusive upper bound (picked day + 1) while both ends stay
// inclusive for the caller — from == to returns exactly that one day.
function parseInboxDate(value, name) {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (!DATE_ONLY_PATTERN.test(value) || !isValidCalendarDate(value)) {
    throw badRequest(`${name} must be a calendar date in YYYY-MM-DD format.`);
  }
  return value;
}

function toIctMidnightIso(dateStr) {
  return new Date(`${dateStr}T00:00:00+07:00`).toISOString();
}

function toNextIctMidnightIso(dateStr) {
  const end = new Date(`${dateStr}T00:00:00+07:00`);
  end.setUTCHours(end.getUTCHours() + 24);
  return end.toISOString();
}

// The frontend must never see storage_path (an internal filesystem path or R2 object key), only
// the API surfaces below — see docs/14-pharmcare-sonnet-implementation-plan.md section 4.7.
function sanitizeAttachment(attachment) {
  if (!attachment) {
    return null;
  }
  const { storagePath, ...safe } = attachment;
  return safe;
}

// route/documentNumber/reviewStatus and the classification diagnostics (reasonCodes,
// classifierVersion) are internal/operational detail — a regular user only needs to know what
// arrived and open it; only admin accounts (see appAuth.js) get the full picture. Stripped
// server-side, not just hidden in the UI, so it never reaches the browser for a non-admin
// session regardless of what the frontend chooses to render.
const ADMIN_ONLY_DOCUMENT_FIELDS = ["route", "documentNumber", "reviewStatus", "reasonCodes", "classifierVersion"];

function sanitizeDocumentForRole(document, role) {
  if (role === "admin") {
    return document;
  }
  const safe = { ...document };
  ADMIN_ONLY_DOCUMENT_FIELDS.forEach((field) => {
    delete safe[field];
  });
  return safe;
}

async function listInbox(req, res) {
  const { status, documentType, duplicate, cursor, limit, order, receivedFrom, receivedTo } = req.query || {};

  if (status && !VALID_REVIEW_STATUSES.includes(status)) {
    throw badRequest(`Invalid status filter. Expected one of: ${VALID_REVIEW_STATUSES.join(", ")}`);
  }
  if (documentType && !VALID_DOCUMENT_TYPES.includes(documentType)) {
    throw badRequest(`Invalid documentType filter. Expected one of: ${VALID_DOCUMENT_TYPES.join(", ")}`);
  }
  if (order && order !== "asc" && order !== "desc") {
    throw badRequest("order must be 'asc' or 'desc'.");
  }

  const receivedFromDate = parseInboxDate(receivedFrom, "receivedFrom");
  const receivedToDate = parseInboxDate(receivedTo, "receivedTo");
  if (receivedFromDate && receivedToDate && receivedFromDate > receivedToDate) {
    throw badRequest("receivedFrom must be on or before receivedTo.");
  }

  const filters = {
    cursor: cursor || undefined,
    documentType: documentType || undefined,
    duplicate: parseDuplicateFilter(duplicate),
    limit: parseLimit(limit),
    order: order || undefined,
    receivedFrom: receivedFromDate ? toIctMidnightIso(receivedFromDate) : undefined,
    receivedTo: receivedToDate ? toNextIctMidnightIso(receivedToDate) : undefined,
    status: status || undefined,
  };

  const [{ documents, nextCursor }, summary] = await Promise.all([
    repository.listInboxDocuments(filters),
    repository.getInboxSummaryCounts(),
  ]);

  res.json({
    documents: documents.map((document) => sanitizeDocumentForRole(document, req.appRole)),
    nextCursor,
    summary,
  });
}

async function getMessageDetail(req, res) {
  const message = await repository.getMessageWithEvidence(req.params.id);

  res.json({
    ...message,
    attachments: message.attachments.map(sanitizeAttachment),
    documents: message.documents.map((document) => sanitizeDocumentForRole(document, req.appRole)),
  });
}

// Authenticated proxy so the browser never sees storage_path or talks to R2/local disk
// directly — matches the existing /api/files/:id/download pattern (fileController.js).
async function downloadAttachment(req, res) {
  const attachment = await repository.getAttachmentById(req.params.id);

  if (!attachment.storagePath) {
    throw notFound(`Attachment has no stored content for id: ${req.params.id}`);
  }

  let stream;
  try {
    stream = await createStoredFileStream(attachment.storageProvider, attachment.storagePath);
  } catch (error) {
    throw notFound(`Attachment content not found for id: ${req.params.id}`);
  }

  res.setHeader("Content-Type", attachment.mimeType || "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(attachment.originalFilename)}"`,
  );

  stream.pipe(res);
}

module.exports = { downloadAttachment, getMessageDetail, listInbox };
