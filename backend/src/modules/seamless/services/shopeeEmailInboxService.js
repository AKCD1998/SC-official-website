const { readShopeeGmailConfigForShop } = require("../config");
const {
  createGmailAdapter,
  normalizeGmailMessage,
} = require("./pharmcare/gmailAdapter");

const SHOPEE_SENDER = "info@mail.shopee.co.th";
const MESSAGE_FETCH_CONCURRENCY = 5;
const INBOX_CACHE_TTL_MS = 15000;
const INBOX_CACHE_MAX_ENTRIES = 100;
const inboxPageCache = new Map();

function extractHeaderEmailAddresses(value) {
  return new Set(
    (String(value || "").match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/giu) || [])
      .map((address) => address.toLowerCase()),
  );
}

function isAddressedToConfiguredMailbox(normalizedMessage, config) {
  const expectedMailbox = String(config.expectedMailbox || config.mailboxAccount || "")
    .trim()
    .toLowerCase();
  return Boolean(
    expectedMailbox && extractHeaderEmailAddresses(normalizedMessage?.visibleTo).has(expectedMailbox),
  );
}

const CATEGORY_QUERIES = {
  order_confirmed: 'subject:"คำสั่งซื้อชำระเงินปลายทาง" subject:"ถูกยืนยันแล้ว"',
  shipment_due: 'subject:"ถึงเวลาจัดส่งสินค้า"',
  order_cancelled: '{subject:"ถูกยกเลิก" subject:"ถูกทำการยกเลิก"}',
  out_of_stock: 'subject:"ขายหมดแล้ว"',
  security_alert: 'subject:"แจ้งเตือนความปลอดภัย"',
  seller_return_delivery: 'subject:"พัสดุกำลังทำการจัดส่งไปยังผู้ขาย"',
};

function classifyShopeeSubject(subject) {
  const value = String(subject || "");
  if (/คำสั่งซื้อชำระเงินปลายทาง.*ถูกยืนยันแล้ว/u.test(value)) return "order_confirmed";
  if (/ถึงเวลาจัดส่งสินค้า/u.test(value)) return "shipment_due";
  if (/ถูก(?:ทำการ)?ยกเลิก/u.test(value)) return "order_cancelled";
  if (/ขายหมดแล้ว/u.test(value)) return "out_of_stock";
  if (/แจ้งเตือนความปลอดภัย/u.test(value)) return "security_alert";
  if (/พัสดุกำลังทำการจัดส่งไปยังผู้ขาย/u.test(value)) return "seller_return_delivery";
  return "other";
}

function extractOrderNumber(subject) {
  return String(subject || "").match(/#([A-Z0-9]+)/iu)?.[1] || "";
}

function extractEmailAddress(headerValue) {
  const value = String(headerValue || "").trim();
  const angleAddress = value.match(/<([^>]+)>/u)?.[1];
  return String(angleAddress || value).trim().toLowerCase();
}

function toGmailEpochSeconds(value, inclusiveLowerBound = false) {
  if (!value) return null;
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) return null;
  const seconds = Math.floor(milliseconds / 1000);
  // Keep the Gmail query one second wider at the lower edge, then enforce the exact
  // [receivedFrom, receivedTo) range against internalDate after messages.get. This avoids
  // depending on Gmail's boundary semantics without leaking the previous ICT day.
  return inclusiveLowerBound ? seconds - 1 : seconds;
}

function buildShopeeGmailQuery(baseQuery, filters = {}) {
  const parts = [`(${baseQuery || `from:${SHOPEE_SENDER}`})`];
  const categoryQuery = CATEGORY_QUERIES[filters.category];
  if (categoryQuery) parts.push(`(${categoryQuery})`);

  const after = toGmailEpochSeconds(filters.receivedFrom, true);
  const before = toGmailEpochSeconds(filters.receivedTo, false);
  if (after !== null) parts.push(`after:${after}`);
  if (before !== null) parts.push(`before:${before}`);
  return parts.join(" ");
}

async function fetchMessagesInBatches(adapter, messageIds) {
  const messages = [];
  const getMessageMetadata = adapter.getMessageMetadata || adapter.getMessage;
  for (let index = 0; index < messageIds.length; index += MESSAGE_FETCH_CONCURRENCY) {
    const batch = messageIds.slice(index, index + MESSAGE_FETCH_CONCURRENCY);
    // A small bounded parallel batch stays well below Gmail's per-user quota burst while
    // avoiding one network round trip at a time for a normal 25-row page.
    // eslint-disable-next-line no-await-in-loop
    const rows = await Promise.allSettled(
      batch.map((messageId) => getMessageMetadata.call(adapter, messageId)),
    );
    const fatalFailure = rows.find(
      (result) => result.status === "rejected" && !isGmailNotFoundError(result.reason),
    );
    if (fatalFailure) {
      // Auth, quota, timeout, and upstream 5xx failures must fail the whole response. Returning
      // a silent partial page would make staff believe the inbox is complete when it is not.
      throw fatalFailure.reason;
    }
    rows.forEach((result) => {
      if (result.status === "fulfilled") {
        messages.push(result.value);
      }
    });
  }
  // A 404 is the one safe failure to skip: a message can disappear between list and get. This
  // also means a page containing only disappeared messages is a valid empty page.
  return messages;
}

function getGmailErrorStatus(error) {
  const status = Number(
    error?.response?.status ?? error?.statusCode ?? error?.status ?? error?.code,
  );
  return Number.isFinite(status) ? status : null;
}

function isGmailNotFoundError(error) {
  return getGmailErrorStatus(error) === 404;
}

function isWithinReceivedRange(rawMessage, filters = {}) {
  if (!filters.receivedFrom && !filters.receivedTo) return true;

  const receivedAt = Number(rawMessage?.internalDate);
  if (!Number.isFinite(receivedAt)) return false;
  const receivedFrom = filters.receivedFrom ? new Date(filters.receivedFrom).getTime() : null;
  const receivedTo = filters.receivedTo ? new Date(filters.receivedTo).getTime() : null;

  return (
    (receivedFrom === null || receivedAt >= receivedFrom) &&
    (receivedTo === null || receivedAt < receivedTo)
  );
}

function mapShopeeEmail(rawMessage, shopCode = "") {
  const message = normalizeGmailMessage(rawMessage);
  const email = {
    id: message.gmailMessageId,
    threadId: message.gmailThreadId,
    receivedAt: message.receivedAt,
    from: message.visibleFrom,
    subject: message.rawSubject,
    category: classifyShopeeSubject(message.rawSubject),
    orderNumber: extractOrderNumber(message.rawSubject),
    unread: message.labelIds.includes("UNREAD"),
  };
  if (shopCode) email.shopCode = shopCode;
  return email;
}

async function loadShopeeEmailInboxPage(filters, baseConfig, adapter, createAdapter = createGmailAdapter) {
  const gmailQuery = buildShopeeGmailQuery(baseConfig.gmailQuery, filters);
  const activeAdapter = adapter || createAdapter({ ...baseConfig, gmailQuery });
  const page = await activeAdapter.listMessagePage({
    maxResults: filters.limit || 25,
    pageToken: filters.cursor || undefined,
  });
  const rawMessages = await fetchMessagesInBatches(activeAdapter, page.messageIds);

  // Gmail's from: query is the primary boundary. Verify the actual From header again before an
  // app user sees the row, so a malformed/changed query cannot accidentally expose unrelated
  // mailbox content.
  const emails = rawMessages
    .filter((message) => isWithinReceivedRange(message, filters))
    .filter((message) => isAddressedToConfiguredMailbox(normalizeGmailMessage(message), baseConfig))
    .map((message) => mapShopeeEmail(message, baseConfig.shopCode))
    .filter((email) => extractEmailAddress(email.from) === SHOPEE_SENDER);

  const result = {
    emails,
    nextCursor: page.nextPageToken,
    source: SHOPEE_SENDER,
  };
  if (baseConfig.shopCode) result.shopCode = baseConfig.shopCode;
  return result;
}

function buildInboxCacheKey(baseConfig, filters) {
  return JSON.stringify([
    baseConfig.mailboxAccount || "",
    baseConfig.shopCode || "",
    baseConfig.gmailQuery || `from:${SHOPEE_SENDER}`,
    filters.category || "",
    filters.cursor || "",
    filters.limit || 25,
    filters.receivedFrom || "",
    filters.receivedTo || "",
  ]);
}

function pruneInboxCache(now) {
  inboxPageCache.forEach((entry, key) => {
    if (entry.expiresAt <= now) inboxPageCache.delete(key);
  });
  if (inboxPageCache.size >= INBOX_CACHE_MAX_ENTRIES) {
    inboxPageCache.delete(inboxPageCache.keys().next().value);
  }
}

async function listShopeeEmailInbox(filters = {}, dependencies = {}) {
  const baseConfig = dependencies.config || readShopeeGmailConfigForShop(filters.shopCode);
  if (dependencies.adapter || dependencies.disableCache) {
    return loadShopeeEmailInboxPage(
      filters,
      baseConfig,
      dependencies.adapter,
      dependencies.createAdapter,
    );
  }

  // A tiny per-instance cache coalesces page refreshes from staff sharing the same filters and
  // reduces Gmail quota pressure. Failures are never cached, and the 15-second TTL keeps this a
  // live operational view rather than a second source of truth.
  const now = Date.now();
  pruneInboxCache(now);
  const cacheKey = buildInboxCacheKey(baseConfig, filters);
  const cached = inboxPageCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = loadShopeeEmailInboxPage(
    filters,
    baseConfig,
    undefined,
    dependencies.createAdapter,
  );
  inboxPageCache.set(cacheKey, { expiresAt: now + INBOX_CACHE_TTL_MS, value });
  try {
    return await value;
  } catch (error) {
    if (inboxPageCache.get(cacheKey)?.value === value) inboxPageCache.delete(cacheKey);
    throw error;
  }
}

module.exports = {
  CATEGORY_QUERIES,
  INBOX_CACHE_TTL_MS,
  SHOPEE_SENDER,
  buildShopeeGmailQuery,
  classifyShopeeSubject,
  extractEmailAddress,
  extractHeaderEmailAddresses,
  extractOrderNumber,
  isGmailNotFoundError,
  isAddressedToConfiguredMailbox,
  isWithinReceivedRange,
  listShopeeEmailInbox,
  mapShopeeEmail,
};
