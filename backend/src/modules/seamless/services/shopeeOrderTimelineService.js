const { readShopeeGmailConfigForShop } = require("../config");
const repository = require("../db/shopeeOrderRepository");
const {
  createGmailAdapter,
  normalizeGmailMessage,
} = require("./pharmcare/gmailAdapter");
const {
  extractEmailAddress,
  isAddressedToConfiguredMailbox,
  isGmailNotFoundError,
  SHOPEE_SENDER,
} = require("./shopeeEmailInboxService");
const { parseShopeeOrderEmail } = require("./shopeeOrderEmailParser");
const { requireShopeeShopCode } = require("./shopeeShops");

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
  const requestedShopCode = requireShopeeShopCode(options.shopCode || dependencies.config?.shopCode);
  const config = dependencies.config || readShopeeGmailConfigForShop(requestedShopCode);
  if (config.shopCode !== requestedShopCode) {
    throw new Error("Shopee Gmail config shopCode does not match the requested shop.");
  }
  const activeRepository = dependencies.repository || repository;
  if (typeof activeRepository.withShopeeOrderSyncLock !== "function") {
    throw new Error("Shopee order repository must provide cross-request sync locking.");
  }

  return activeRepository.withShopeeOrderSyncLock(
    requestedShopCode,
    config.mailboxAccount,
    async () => {
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
        // Automatic forwarding normally preserves the original To header. Only the mailbox that
        // was the original Shopee recipient may claim the event; a forwarded copy in another
        // configured mailbox is skipped before persistence. Missing/ambiguous recipients fail
        // closed instead of allowing sync order to decide shop ownership.
        if (!isAddressedToConfiguredMailbox(normalized, config)) {
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

      return {
        deduplicatedEvents,
        nextCursor: page.nextPageToken || null,
        processedMessages: rawMessages.length,
        shopCode: requestedShopCode,
        skippedMessages,
        source: SHOPEE_SENDER,
        storedEvents,
      };
    },
  );
}

module.exports = {
  FULL_MESSAGE_FETCH_CONCURRENCY,
  fetchFullMessagesInBatches,
  syncShopeeOrderPage,
};
