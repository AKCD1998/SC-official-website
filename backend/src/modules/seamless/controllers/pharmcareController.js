const repository = require("../db/pharmcareRepository");
const { badRequest } = require("../errors");

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

// The frontend must never see storage_path (an internal filesystem path or R2 object key), only
// the API surfaces below — see docs/14-pharmcare-sonnet-implementation-plan.md section 4.7.
function sanitizeAttachment(attachment) {
  if (!attachment) {
    return null;
  }
  const { storagePath, ...safe } = attachment;
  return safe;
}

async function listInbox(req, res) {
  const { status, documentType, duplicate, cursor, limit } = req.query || {};

  if (status && !VALID_REVIEW_STATUSES.includes(status)) {
    throw badRequest(`Invalid status filter. Expected one of: ${VALID_REVIEW_STATUSES.join(", ")}`);
  }
  if (documentType && !VALID_DOCUMENT_TYPES.includes(documentType)) {
    throw badRequest(`Invalid documentType filter. Expected one of: ${VALID_DOCUMENT_TYPES.join(", ")}`);
  }

  const filters = {
    cursor: cursor || undefined,
    documentType: documentType || undefined,
    duplicate: parseDuplicateFilter(duplicate),
    limit: parseLimit(limit),
    status: status || undefined,
  };

  const [{ documents, nextCursor }, summary] = await Promise.all([
    repository.listInboxDocuments(filters),
    repository.getInboxSummaryCounts(),
  ]);

  res.json({ documents, nextCursor, summary });
}

async function getMessageDetail(req, res) {
  const message = await repository.getMessageWithEvidence(req.params.id);

  res.json({
    ...message,
    attachments: message.attachments.map(sanitizeAttachment),
  });
}

module.exports = { getMessageDetail, listInbox };
