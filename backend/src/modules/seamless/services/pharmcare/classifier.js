const { classifyAttachment, classifyReceiptLinkPending } = require("./documentClassifier");
const { resolveOriginalIdentity } = require("./emailNormalizer");

// pharmcare_business@ / pharmcare_ops@googlegroups.com have only ever been observed as CC, never
// as a confirmed sender — see docs/13-pharmcare-finance-email-automation.md section 2. Only the
// confirmed sender is allowlisted by default.
const DEFAULT_SENDER_ALLOWLIST = ["info@pharmcare.co"];

const CLASSIFIER_VERSION = "pharmcare-classifier-v1";

function classifyDocumentList({ attachments, isSenderAllowed, normalizedSubject }) {
  const documents = attachments.map((attachment) => {
    const classification = classifyAttachment({
      filename: attachment.filename,
      normalizedSubject,
    });

    return buildDocument(attachment, classification, isSenderAllowed);
  });

  if (!attachments.length) {
    const receiptClassification = classifyReceiptLinkPending({
      hasAttachment: false,
      normalizedSubject,
    });

    if (receiptClassification) {
      documents.push(buildDocument(null, receiptClassification, isSenderAllowed));
    }
  }

  return documents;
}

function buildDocument(attachment, classification, isSenderAllowed) {
  const reasonCodes = isSenderAllowed
    ? classification.reasonCodes
    : [...classification.reasonCodes, "sender_not_allowlisted"];

  return {
    attachmentId: attachment ? attachment.attachmentId : null,
    filename: attachment ? attachment.filename : null,
    ...classification,
    reasonCodes,
    reviewStatus: isSenderAllowed ? classification.reviewStatus : "manual_review",
  };
}

// Pure function: no Gmail/DB/R2 access. Takes a normalized email DTO (already extracted from a
// Gmail message by an adapter) and returns classification evidence for the message and every
// attachment, never a bare boolean, so the ingestion service and UI/audit trail can show why.
function classifyPharmcareEmail(input, options = {}) {
  const allowlist = (options.senderAllowlist || DEFAULT_SENDER_ALLOWLIST).map((email) =>
    String(email).trim().toLowerCase(),
  );

  const identity = resolveOriginalIdentity({
    bodyText: input.bodyText,
    rawSubject: input.rawSubject,
    routeHint: input.routeHint,
    visibleFrom: input.visibleFrom,
  });

  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  const isSenderAllowed = Boolean(identity.originalFrom) && allowlist.includes(identity.originalFrom);

  const messageReasonCodes = [];
  if (!isSenderAllowed) {
    messageReasonCodes.push("sender_not_allowlisted");
  }
  if (identity.route === "manual_forward" && !identity.forwardedBlockFound) {
    messageReasonCodes.push("forwarded_block_not_found");
  }

  const documents = classifyDocumentList({
    attachments,
    isSenderAllowed,
    normalizedSubject: identity.originalSubject,
  });

  if (!documents.length) {
    messageReasonCodes.push("no_documents_identified");
  }

  const hasManualReviewDocument = documents.some((doc) => doc.reviewStatus === "manual_review");
  const status = !isSenderAllowed || hasManualReviewDocument || !documents.length
    ? "manual_review"
    : "classified";

  return {
    classifierVersion: CLASSIFIER_VERSION,
    documents,
    forwardedBlockFound: identity.forwardedBlockFound,
    isSenderAllowed,
    normalizedSubject: identity.normalizedSubject,
    originalDate: identity.originalDate,
    originalFrom: identity.originalFrom,
    originalSubject: identity.originalSubject,
    reasonCodes: messageReasonCodes,
    route: identity.route,
    status,
  };
}

module.exports = { CLASSIFIER_VERSION, DEFAULT_SENDER_ALLOWLIST, classifyPharmcareEmail };
