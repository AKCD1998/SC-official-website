const { readShopeeGmailConfigForShop } = require("../config");
const repository = require("../db/shopeeOrderRepository");
const {
  createGmailAdapter,
  normalizeGmailMessage,
} = require("./pharmcare/gmailAdapter");
const {
  extractEmailAddress,
  isGmailNotFoundError,
  SHOPEE_SENDER,
} = require("./shopeeEmailInboxService");
const { parseShopeeOrderEmail } = require("./shopeeOrderEmailParser");

const FULL_MESSAGE_FETCH_CONCURRENCY = 5;

async function fetchFullMessagesInBatches(adapter, messageIds) {
  const messages = [];
  const getFullMessage = adapter.getMessageBounded || adapter.getMessage;
  for (let index = 0; index < messageIds.length; index += FULL_MESSAGE_FETCH_CONCURRENCY) {
    const batch = messageIds.slice(index, index + FULL_MESSAGE_FETCH_CONCURRENCY);
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.allSettled(
      batch.map((messageId) => getFullMessage.call(adapter, messageId)),
    );
    const fatalFailure = results.find(
      (result) => result.status === "rejected" && !isGmailNotFoundError(result.reason),
    );
    if (fatalFailure) throw fatalFailure.reason;
    results.forEach((result) => {
      if (result.status === "fulfilled") messages.push(result.value);
    });
  }
  return messages;
}

async function syncShopeeOrderPage(options = {}, dependencies = {}) {
  const config = dependencies.config || readShopeeGmailConfigForShop(options.shopCode);
  const activeRepository = dependencies.repository || repository;
  if (typeof activeRepository.withShopeeOrderSyncLock !== "function") {
    throw new Error("Shopee order repository must provide cross-request sync locking.");
  }

  return activeRepository.withShopeeOrderSyncLock(config.mailboxAccount, async () => {
    const adapter = dependencies.adapter || createGmailAdapter(config);
    const page = await adapter.listMessagePage({
      maxResults: options.limit || 25,
      pageToken: options.cursor || undefined,
    });
    const rawMessages = await fetchFullMessagesInBatches(adapter, page.messageIds);

    let storedEvents = 0;
    let deduplicatedEvents = 0;
    let skippedMessages = page.messageIds.length - rawMessages.length;

    for (const rawMessage of rawMessages) {
      const normalized = normalizeGmailMessage(rawMessage);
      if (extractEmailAddress(normalized.visibleFrom) !== SHOPEE_SENDER) {
        skippedMessages += 1;
        continue;
      }

      const parsed = parseShopeeOrderEmail(
        rawMessage,
        config.mailboxAccount,
        config.shopCode,
      );
      if (!parsed) {
        skippedMessages += 1;
        continue;
      }

      // Sequential DB transactions keep each order+event atomic and avoid opening 25 concurrent
      // PostgreSQL clients after the bounded Gmail batch has completed.
      // eslint-disable-next-line no-await-in-loop
      const result = await activeRepository.upsertOrderEvent(parsed);
      if (result.eventCreated) storedEvents += 1;
      else deduplicatedEvents += 1;
    }

    const result = {
      deduplicatedEvents,
      nextCursor: page.nextPageToken || null,
      processedMessages: rawMessages.length,
      skippedMessages,
      source: SHOPEE_SENDER,
      storedEvents,
    };
    if (config.shopCode) result.shopCode = config.shopCode;
    return result;
  });
}

module.exports = {
  FULL_MESSAGE_FETCH_CONCURRENCY,
  fetchFullMessagesInBatches,
  syncShopeeOrderPage,
};
