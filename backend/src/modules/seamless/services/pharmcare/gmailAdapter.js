const { readPharmcareGmailConfig } = require("../../config");
const { serviceUnavailable } = require("../../errors");

const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_INBOX_REQUEST_TIMEOUT_MS = 10000;

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
// to gmail.readonly only, and the adapter exposes only read operations (plus the established
// Gmail watch subscription used by PharmCare) — it has no code path that could send,
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
      `Unsupported Gmail auth mode for ${config.credentialEnvPrefix || "the configured mailbox"}: '${config.authMode}' (expected 'service_account' or 'oauth_refresh_token').`,
    );
  }

  return google.gmail({ auth, version: "v1" });
}

function createGmailAdapter(configOverride, deps = {}) {
  const config = configOverride || readPharmcareGmailConfig();
  // Injectable for tests: deps.createGmailClient(config) -> { users: { messages: {...} } }
  const createGmailClient = deps.createGmailClient || (() => createDefaultGmailClient(config));
  let gmailClient = null;
  let verifiedClientPromise = null;

  function client() {
    if (!gmailClient) {
      gmailClient = createGmailClient(config);
    }
    return gmailClient;
  }

  async function verifiedClient() {
    if (!verifiedClientPromise) {
      verifiedClientPromise = (async () => {
        const activeClient = client();
        if (config.expectedMailbox) {
          const { data } = await activeClient.users.getProfile({ userId: "me" });
          if (data?.emailAddress !== config.expectedMailbox) {
            throw serviceUnavailable(
              "Gmail account identity check failed for the configured mailbox.",
            );
          }
        }
        return activeClient;
      })();
    }
    return verifiedClientPromise;
  }

  function assertConfigured() {
    if (!isGmailConfigured(config)) {
      throw serviceUnavailable(
        `Gmail read-only adapter is not configured. Set ${config.credentialEnvPrefix || "SEAMLESS_PHARMCARE_GMAIL"}_AUTH_MODE and its matching credential env vars.`,
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
    const activeClient = await verifiedClient();

    const messageIds = [];
    let pageToken;
    do {
      // eslint-disable-next-line no-await-in-loop
      const { data } = await activeClient.users.messages.list({
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

  // One Gmail result page with its opaque page token. PharmCare's ingestion path deliberately
  // scans all candidate pages via listCandidateMessageIds(); the Shopee read-only inbox instead
  // needs user-driven pagination and therefore must preserve Gmail's nextPageToken.
  async function listMessagePage({ after, maxResults = 25, pageToken } = {}) {
    assertConfigured();
    const activeClient = await verifiedClient();

    const safeLimit = Number.isFinite(Number(maxResults))
      ? Math.min(Math.max(Number(maxResults), 1), 100)
      : 25;
    const { data } = await activeClient.users.messages.list(
      {
        userId: "me",
        q: buildQuery(after),
        maxResults: safeLimit,
        pageToken: pageToken || undefined,
      },
      { retry: false, timeout: GMAIL_INBOX_REQUEST_TIMEOUT_MS },
    );

    return {
      messageIds: (data.messages || []).map((message) => message.id),
      nextPageToken: data.nextPageToken || null,
    };
  }

  async function getMessage(messageId) {
    assertConfigured();
    const activeClient = await verifiedClient();

    const { data } = await activeClient.users.messages.get({
      format: "full",
      id: messageId,
      userId: "me",
    });
    return data;
  }

  // Interactive Shopee timeline sync fetches full MIME bodies, but unlike PharmCare's scheduled
  // ingestion it must stay within one user-request budget. This separate operation deliberately
  // disables client retries and applies the same timeout as the live inbox, without changing the
  // established PharmCare ingestion behavior of getMessage().
  async function getMessageBounded(messageId) {
    assertConfigured();
    const activeClient = await verifiedClient();

    const { data } = await activeClient.users.messages.get(
      {
        format: "full",
        id: messageId,
        userId: "me",
      },
      { retry: false, timeout: GMAIL_INBOX_REQUEST_TIMEOUT_MS },
    );
    return data;
  }

  // Shopee's live inbox only needs envelope metadata. Keeping this separate from getMessage()
  // preserves PharmCare ingestion's full MIME/attachment behavior while ensuring the live UI
  // never downloads message bodies it will not return or display.
  async function getMessageMetadata(messageId) {
    assertConfigured();
    const activeClient = await verifiedClient();

    const { data } = await activeClient.users.messages.get(
      {
        fields: "id,threadId,internalDate,labelIds,payload(headers)",
        format: "metadata",
        id: messageId,
        metadataHeaders: ["From", "Subject", "To"],
        userId: "me",
      },
      { retry: false, timeout: GMAIL_INBOX_REQUEST_TIMEOUT_MS },
    );
    return data;
  }

  // Legacy shop reconciliation needs routing evidence only. Keeping this separate from the
  // inbox metadata reader ensures an admin review never requests or exposes Subject/body data.
  async function getMessageRoutingMetadata(messageId) {
    assertConfigured();
    const activeClient = await verifiedClient();

    const { data } = await activeClient.users.messages.get(
      {
        fields: "id,internalDate,payload(headers)",
        format: "metadata",
        id: messageId,
        metadataHeaders: ["From", "To"],
        userId: "me",
      },
      { retry: false, timeout: GMAIL_INBOX_REQUEST_TIMEOUT_MS },
    );
    return data;
  }

  async function getAttachment(messageId, attachmentId) {
    assertConfigured();
    const activeClient = await verifiedClient();

    const { data } = await activeClient.users.messages.attachments.get({
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
    const activeClient = await verifiedClient();

    const { data } = await activeClient.users.watch({
      requestBody: {
        labelFilterBehavior: "INCLUDE",
        labelIds: ["INBOX"],
        topicName,
      },
      userId: "me",
    });
    return { expiration: data.expiration, historyId: data.historyId };
  }

  return {
    getAttachment,
    getMessage,
    getMessageBounded,
    getMessageMetadata,
    getMessageRoutingMetadata,
    listCandidateMessageIds,
    listMessagePage,
    watchMailbox,
  };
}

// Test/dry-run double: backed entirely by an in-memory fixture list, so ingestion logic can be
// exercised end-to-end without any Gmail/network access. Fixture messages use the same shape
// normalizeGmailMessage() expects from the real Gmail API (headers array + payload parts).
function createMockGmailAdapter(fixtureMessages = []) {
  const messagesById = new Map(fixtureMessages.map((message) => [message.id, message]));

  async function listCandidateMessageIds() {
    return Array.from(messagesById.keys());
  }

  async function listMessagePage({ maxResults = 25 } = {}) {
    return {
      messageIds: Array.from(messagesById.keys()).slice(0, maxResults),
      nextPageToken: null,
    };
  }

  async function getMessage(messageId) {
    const message = messagesById.get(messageId);
    if (!message) {
      throw serviceUnavailable(`Mock Gmail message not found: ${messageId}`);
    }
    return message;
  }

  async function getMessageBounded(messageId) {
    return getMessage(messageId);
  }

  async function getMessageMetadata(messageId) {
    return getMessage(messageId);
  }

  async function getMessageRoutingMetadata(messageId) {
    return getMessage(messageId);
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

  return {
    getAttachment,
    getMessage,
    getMessageBounded,
    getMessageMetadata,
    getMessageRoutingMetadata,
    listCandidateMessageIds,
    listMessagePage,
    watchMailbox,
  };
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
    labelIds: rawMessage.labelIds || [],
    rawSubject: getHeader(headers, "Subject"),
    receivedAt: rawMessage.internalDate
      ? new Date(Number(rawMessage.internalDate)).toISOString()
      : null,
    snippet: rawMessage.snippet || "",
    visibleCc: getHeader(headers, "Cc"),
    visibleFrom: getHeader(headers, "From"),
    visibleTo: getHeader(headers, "To"),
  };
}

module.exports = {
  GMAIL_INBOX_REQUEST_TIMEOUT_MS,
  GMAIL_READONLY_SCOPE,
  createGmailAdapter,
  createMockGmailAdapter,
  isGmailConfigured,
  normalizeGmailMessage,
};
