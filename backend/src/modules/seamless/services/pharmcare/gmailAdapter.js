const { readPharmcareGmailConfig } = require("../../config");
const { serviceUnavailable } = require("../../errors");

const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

function isGmailConfigured(config = readPharmcareGmailConfig()) {
  if (config.authMode === "service_account") {
    return Boolean(config.serviceAccountJson && config.impersonatedUser);
  }

  if (config.authMode === "oauth_refresh_token") {
    return Boolean(config.clientId && config.clientSecret && config.refreshToken);
  }

  return false;
}

// Real adapter interface. Implementation is deferred: this repo has no Gmail credential
// provisioned yet (see docs/14-pharmcare-sonnet-implementation-plan.md section 4.6), and wiring
// an untested googleapis integration without any credential to run it against would be
// speculative. Config validation and the mock adapter below (used by ingestion tests and any
// future dry-run script) are what Milestone 1 asks for in that situation. Read-only scope only —
// this adapter must never send, forward, delete, or label a Gmail message.
function createGmailAdapter(configOverride) {
  const config = configOverride || readPharmcareGmailConfig();

  function assertConfigured() {
    if (!isGmailConfigured(config)) {
      throw serviceUnavailable(
        "PharmCare Gmail adapter is not configured. Set SEAMLESS_PHARMCARE_GMAIL_AUTH_MODE and its matching credential env vars.",
      );
    }
  }

  async function listCandidateMessageIds() {
    assertConfigured();
    throw serviceUnavailable(
      "Live Gmail ingestion is not implemented yet — provision credentials and complete the googleapis integration before enabling this path.",
    );
  }

  async function getMessage() {
    assertConfigured();
    throw serviceUnavailable(
      "Live Gmail ingestion is not implemented yet — provision credentials and complete the googleapis integration before enabling this path.",
    );
  }

  async function getAttachment() {
    assertConfigured();
    throw serviceUnavailable(
      "Live Gmail ingestion is not implemented yet — provision credentials and complete the googleapis integration before enabling this path.",
    );
  }

  return { getAttachment, getMessage, listCandidateMessageIds };
}

// Test/dry-run double: backed entirely by an in-memory fixture list, so ingestion logic can be
// exercised end-to-end without any Gmail/network access. Fixture messages use the same shape
// normalizeGmailMessage() expects from the real Gmail API (headers array + payload parts).
function createMockGmailAdapter(fixtureMessages = []) {
  const messagesById = new Map(fixtureMessages.map((message) => [message.id, message]));

  async function listCandidateMessageIds() {
    return Array.from(messagesById.keys());
  }

  async function getMessage(messageId) {
    const message = messagesById.get(messageId);
    if (!message) {
      throw serviceUnavailable(`Mock Gmail message not found: ${messageId}`);
    }
    return message;
  }

  async function getAttachment(messageId, attachmentId) {
    const message = messagesById.get(messageId);
    const attachment = message?.attachments?.find((item) => item.attachmentId === attachmentId);
    if (!attachment) {
      throw serviceUnavailable(`Mock Gmail attachment not found: ${messageId}/${attachmentId}`);
    }
    return attachment.data;
  }

  return { getAttachment, getMessage, listCandidateMessageIds };
}

function getHeader(headers, name) {
  const header = (headers || []).find((item) => String(item.name).toLowerCase() === name.toLowerCase());
  return header ? header.value : "";
}

// Converts a Gmail-API-shaped message (headers + payload.parts, as returned by
// users.messages.get with format=full) into the flat DTO the pure classifier and ingestion
// service consume. Kept pure/synchronous — attachment bytes are fetched separately via
// getAttachment() and passed in by the caller, not fetched here.
function normalizeGmailMessage(rawMessage) {
  const headers = rawMessage?.payload?.headers || [];
  const parts = rawMessage?.payload?.parts || [];

  const textPart = parts.find((part) => part.mimeType === "text/plain");
  const bodyText = textPart?.body?.data
    ? Buffer.from(textPart.body.data, "base64").toString("utf8")
    : rawMessage?.bodyText || "";

  const attachments = parts
    .filter((part) => part.filename && part.body && part.body.attachmentId)
    .map((part) => ({
      attachmentId: part.body.attachmentId,
      filename: part.filename,
      mimeType: part.mimeType || "",
      sizeBytes: part.body.size || 0,
    }));

  return {
    attachments,
    bodyText,
    gmailMessageId: rawMessage.id,
    gmailThreadId: rawMessage.threadId || "",
    rawSubject: getHeader(headers, "Subject"),
    receivedAt: rawMessage.internalDate
      ? new Date(Number(rawMessage.internalDate)).toISOString()
      : null,
    visibleCc: getHeader(headers, "Cc"),
    visibleFrom: getHeader(headers, "From"),
    visibleTo: getHeader(headers, "To"),
  };
}

module.exports = {
  GMAIL_READONLY_SCOPE,
  createGmailAdapter,
  createMockGmailAdapter,
  isGmailConfigured,
  normalizeGmailMessage,
};
