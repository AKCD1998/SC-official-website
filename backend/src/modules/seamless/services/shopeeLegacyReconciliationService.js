const { readShopeeGmailConfigForShop } = require("../config");
const repository = require("../db/shopeeLegacyReconciliationRepository");
const {
  createGmailAdapter,
  normalizeGmailMessage,
} = require("./pharmcare/gmailAdapter");
const {
  extractEmailAddress,
  extractHeaderEmailAddresses,
  isGmailNotFoundError,
  SHOPEE_SENDER,
} = require("./shopeeEmailInboxService");
const { requireShopeeShopCode, SHOPEE_SHOP_PROFILES } = require("./shopeeShops");

const ROUTING_METADATA_CONCURRENCY = 5;

function publicOrder(order, evidence) {
  return {
    currentStatus: order.currentStatus,
    decision: order.decision,
    eventCount: order.eventCount,
    evidence,
    firstEventAt: order.firstEventAt,
    lastEventAt: order.lastEventAt,
    orderNumber: order.orderNumber,
  };
}

function routingConfigs(dependencies = {}) {
  if (dependencies.configs) return dependencies.configs;
  return Object.keys(SHOPEE_SHOP_PROFILES).map((shopCode) => (
    readShopeeGmailConfigForShop(shopCode)
  ));
}

async function mapWithConcurrency(values, worker, concurrency = ROUTING_METADATA_CONCURRENCY) {
  const output = new Array(values.length);
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      // eslint-disable-next-line no-await-in-loop
      output[index] = await worker(values[index]);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    () => runWorker(),
  ));
  return output;
}

async function resolveLegacyRoutingEvidence(order, dependencies = {}) {
  const configs = routingConfigs(dependencies);
  const configByMailbox = new Map(configs.map((config) => (
    [String(config.mailboxAccount || "").trim().toLowerCase(), config]
  )));
  const expectedShopByRecipient = new Map(configs.map((config) => (
    [
      String(config.expectedMailbox || config.mailboxAccount || "").trim().toLowerCase(),
      config.shopCode,
    ]
  )));
  const adapters = dependencies.adapters || new Map();
  const createAdapter = dependencies.createAdapter || createGmailAdapter;

  const results = await mapWithConcurrency(order.sourceEvents || [], async (event) => {
    const mailboxKey = String(event.mailboxAccount || "").trim().toLowerCase();
    const config = configByMailbox.get(mailboxKey);
    if (!config) return { type: "metadata_unavailable" };
    if (!adapters.has(mailboxKey)) adapters.set(mailboxKey, createAdapter(config));
    try {
      const raw = await adapters.get(mailboxKey)
        .getMessageRoutingMetadata(event.gmailMessageId);
      const normalized = normalizeGmailMessage(raw);
      if (extractEmailAddress(normalized.visibleFrom) !== SHOPEE_SENDER) {
        return { type: "recipient_unknown" };
      }
      const recipients = extractHeaderEmailAddresses(normalized.visibleTo);
      const matches = [...recipients]
        .map((recipient) => expectedShopByRecipient.get(recipient))
        .filter(Boolean);
      if (new Set(matches).size !== 1) return { type: "recipient_unknown" };
      return { shopCode: matches[0], type: "recipient_match" };
    } catch (error) {
      return { type: isGmailNotFoundError(error) ? "message_not_found" : "metadata_unavailable" };
    }
  }, dependencies.metadataConcurrency || ROUTING_METADATA_CONCURRENCY);

  const candidates = new Set(results.map((result) => result.shopCode).filter(Boolean));
  let evidenceStatus = "recipient_unknown";
  if (candidates.size > 1) evidenceStatus = "recipient_conflict";
  else if (candidates.size === 1) evidenceStatus = "recipient_match";
  else if (results.length && results.every((result) => result.type === "message_not_found")) {
    evidenceStatus = "message_not_found";
  } else if (results.some((result) => result.type === "metadata_unavailable")) {
    evidenceStatus = "metadata_unavailable";
  }

  return {
    evidenceStatus,
    matchedEventCount: results.filter((result) => result.type === "recipient_match").length,
    suggestedShopCode: candidates.size === 1 ? [...candidates][0] : null,
    totalEventCount: results.length,
  };
}

async function listLegacyReconciliationPage(filters = {}, dependencies = {}) {
  const activeRepository = dependencies.repository || repository;
  const result = await activeRepository.listLegacyOrders(filters);
  const evidenceDependencies = {
    ...dependencies,
    adapters: dependencies.adapters || new Map(),
    configs: routingConfigs(dependencies),
    // The outer order worker already runs five-wide. Keeping each order's event reads serial
    // caps the request-wide Gmail metadata concurrency at five rather than multiplying it.
    metadataConcurrency: 1,
  };
  const orders = await mapWithConcurrency(result.orders, async (order) => {
    const evidence = await resolveLegacyRoutingEvidence(order, evidenceDependencies);
    return publicOrder(order, evidence);
  });
  return { ...result, orders };
}

async function reviewLegacyOrder({ orderNumber, selectedShopCode }, dependencies = {}) {
  const activeRepository = dependencies.repository || repository;
  const shopCode = requireShopeeShopCode(selectedShopCode);
  const order = await activeRepository.getLegacyOrder(orderNumber);
  const evidence = await resolveLegacyRoutingEvidence(order, dependencies);
  const decision = await activeRepository.saveDecision({
    evidenceStatus: evidence.evidenceStatus,
    orderNumber,
    selectedShopCode: shopCode,
    suggestedShopCode: evidence.suggestedShopCode,
  });
  return {
    decision,
    evidence,
    orderNumber,
    reviewOnly: true,
  };
}

module.exports = {
  ROUTING_METADATA_CONCURRENCY,
  listLegacyReconciliationPage,
  mapWithConcurrency,
  resolveLegacyRoutingEvidence,
  reviewLegacyOrder,
};
