const { normalizeGmailMessage } = require("./pharmcare/gmailAdapter");
const { ingestNormalizedMessage } = require("./pharmcareIngestionService");

// Orchestrates one full ingestion cycle against a Gmail adapter (real or mock):
//   adapter.listCandidateMessageIds() -> adapter.getMessage() -> normalizeGmailMessage()
//   -> adapter.getAttachment() per attachment -> ingestNormalizedMessage()
//
// The adapter is the only thing that talks to Gmail, and it is read-only by contract (see
// docs/13/14) — this function never sends, forwards, deletes, or labels anything. One message
// failing (a bad attachment fetch, a classifier edge case) is caught and reported per-message so
// it never aborts the rest of the batch, and re-running this against already-ingested messages is
// safe because ingestNormalizedMessage() is itself idempotent.
async function syncMessagesFromAdapter(adapter, mailboxAccount, options = {}) {
  const messageIds = await adapter.listCandidateMessageIds();
  const results = [];

  for (const messageId of messageIds) {
    try {
      const rawMessage = await adapter.getMessage(messageId);
      const normalized = normalizeGmailMessage(rawMessage);

      const attachments = [];
      for (const attachmentMeta of normalized.attachments) {
        // eslint-disable-next-line no-await-in-loop
        const buffer = await adapter.getAttachment(messageId, attachmentMeta.attachmentId);
        attachments.push({ ...attachmentMeta, buffer });
      }

      // eslint-disable-next-line no-await-in-loop
      const outcome = await ingestNormalizedMessage({ ...normalized, attachments, mailboxAccount }, options);
      results.push({ gmailMessageId: messageId, ...outcome });
    } catch (error) {
      results.push({ error: error.message, gmailMessageId: messageId, status: "failed" });
    }
  }

  return results;
}

module.exports = { syncMessagesFromAdapter };
