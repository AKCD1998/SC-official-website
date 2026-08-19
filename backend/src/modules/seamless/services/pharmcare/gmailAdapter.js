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

// Real adapter backed by googleapis. Read-only by construction: the OAuth/JWT client is scoped
// to gmail.readonly only, and the adapter exposes exactly three read operations
// (messages.list / messages.get / attachments.get) — it has no code path that could send,
// forward, delete, mark-read, or label a message, even if callers wanted it to.
//
// Auth modes (see docs/14 section 4.6), selected by SEAMLESS_PHARMCARE_GMAIL_AUTH_MODE:
//   - "service_account" (preferred): service-account JSON + domain-wide delegation,
//     impersonating the admin mailbox via the JWT subject.
//   - "oauth_refresh_token" (fallback): OAuth client id/secret + the mailbox's refresh token.
// Credentials come only from env vars — never from code or git.
function createDefaultGmailClient(config) {
  // Required lazily so tests and any environment without the googleapis package installed
  // (e.g. a client-only checkout) don't pay for / break on the import.
  const { google } = require("googleapis");

  let auth;
  if (config.authMode === "service_account") {
    auth = new google.auth.JWT({
      email: JSON.parse(config.serviceAccountJson).client_email,
      key: config.serviceAccountJson,
      scopes: [GMAIL_READONLY_SCOPE],
      subject: config.impersonatedUser,
    });
  } else if (config.authMode === "oauth_refresh_token") {
    auth = new google.auth.OAuth2(config.clientId, config.clientSecret);
    auth.setCredentials({ refresh_token: config.refreshToken });
  } else {
    throw serviceUnavailable(
      `Unsupported SEAMLESS_PHARMCARE_GMAIL_AUTH_MODE: '${config.authMode}' (expected 'service_account' or 'oauth_refresh_token').`,
    );
  }

  return google.gmail({ auth, version: "v1" });
}

function createGmailAdapter(configOverride, deps = {}) {
  const config = configOverride || readPharmcareGmailConfig();
  // Injectable for tests: deps.createGmailClient(config) -> { users: { messages: {...} } }
  const createGmailClient = deps.createGmailClient || (() => createDefaultGmailClient(config));
  let gmailClient = null;

  function client() {
    if (!gmailClient) {
      gmailClient = createGmailClient(config);
    }
    return gmailClient;
  }

  function assertConfigured() {
    if (!isGmailConfigured(config)) {
      throw serviceUnavailable(
        "PharmCare Gmail adapter is not configured. Set SEAMLESS_PHARMCARE_GMAIL_AUTH_MODE and its matching credential env vars.",
      );
    }
  }

  // `after` (Date or ISO string) narrows the search to messages received after a checkpoint
  // timestamp, expressed as Gmail's epoch-seconds `after:` operator.
  function buildQuery(after) {
    const parts = [];
    if (config.gmailQuery) {
      parts.push(`(${config.gmailQuery})`);
    }
    if (after) {
      const afterSeconds = Math.floor(new Date(after).getTime() / 1000);
      if (Number.isFinite(afterSeconds)) {
        parts.push(`after:${afterSeconds}`);
      }
    }
    return parts.join(" ");
  }

  async function listCandidateMessageIds({ after, maxResults = 500 } = {}) {
    assertConfigured();

    const messageIds = [];
    let pageToken;
    do {
      // eslint-disable-next-line no-await-in-loop
      const { data } = await client().users.messages.list({
        userId: "me",
        q: buildQuery(after),
        maxResults: 100,
        pageToken,
      });
      (data.messages || []).forEach((message) => messageIds.push(message.id));
      pageToken = data.nextPageToken;
    } while (pageToken && messageIds.length < maxResults);

    return messageIds;
  }

  async function getMessage(messageId) {
    assertConfigured();

    const { data } = await client().users.messages.get({
      format: "full",
      id: messageId,
      userId: "me",
    });
    return data;
  }

  async function getAttachment(messageId, attachmentId) {
    assertConfigured();

    const { data } = await client().users.messages.attachments.get({
      id: attachmentId,
      messageId,
      userId: "me",
    });
    // Gmail returns attachment data as base64url with no padding.
    return Buffer.from(data.data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  }

  // Starts (or renews — calling this again before expiry just extends it) Gmail push
  // notifications for the mailbox: Gmail will publish a message to topicName every time this
  // mailbox changes. This does not read or return any message content — it's a subscribe call,
  // not a read call — but it's still access-controlled the same way (assertConfigured) since it
  // acts on the mailbox. Expires in <= 7 days; callers must re-call this periodically.
  async function watchMailbox(topicName) {
    assertConfigured();

    const { data } = await client().users.watch({
      requestBody: { labelIds: ["INBOX"], topicName },
      userId: "me",
    });
    return { expiration: data.expiration, historyId: data.historyId };
  }

  return { getAttachment, getMessage, listCandidateMessageIds, watchMailbox };
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

  async function watchMailbox() {
    return { expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000), historyId: "mock-history-id" };
  }

  return { getAttachment, getMessage, listCandidateMessageIds, watchMailbox };
}

function getHeader(headers, name) {
  const header = (headers || []).find((item) => String(item.name).toLowerCase() === name.toLowerCase());
  return header ? header.value : "";
}

// Converts a Gmail-API-shaped message (headers + payload.parts, as returned by
// users.messages.get with format=full) into the flat DTO the pure classifier and ingestion
// service consume. Kept pure/synchronous — attachment bytes are fetched separately via
// getAttachment() and passed in by the caller, not fetched here.
// Gmail MIME parts nest: a top-level payload.parts entry can itself be a multipart/alternative
// (or multipart/related, etc.) container holding the actual text/plain and text/html parts,
// sitting alongside sibling attachment parts. A single-level parts.find() misses any part nested
// this way — observed live on a real PharmCare forward (parts: [multipart/alternative,
// application/octet-stream, application/octet-stream]) where the text/plain lived inside the
// multipart/alternative child, leaving bodyText empty and silently breaking forwarded-block
// parsing (original sender came back null even though the message genuinely was PharmCare).
// This walks the whole part tree instead of assuming it is flat.
function flattenParts(part, into) {
  if (!part) return into;
  into.push(part);
  if (Array.isArray(part.parts)) {
    part.parts.forEach((child) => flattenParts(child, into));
  }
  return into;
}

function normalizeGmailMessage(rawMessage) {
  const headers = rawMessage?.payload?.headers || [];
  const parts = flattenParts(rawMessage?.payload, []);

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
