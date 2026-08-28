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
const {
  getShopeeProductCatalogSummary,
  matchShopeeProduct,
} = require("./shopeeProductMatcher");

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

function publicProductMatch(match) {
  const output = {
    status: match.status,
  };
  if (match.companySku) output.companySku = match.companySku;
  if (Array.isArray(match.components)) {
    output.components = match.components.map((component) => ({
      companySku: component.companySku,
      quantityPerSale: component.quantityPerSale,
    }));
  }
  if (match.quantityRuleStatus) output.quantityRuleStatus = match.quantityRuleStatus;
  if (match.reasonCode) output.reasonCode = match.reasonCode;
  return output;
}

function resolveLegacyProductEvidence(order, dependencies = {}) {
  const matcher = dependencies.matchProduct || matchShopeeProduct;
  const items = Array.isArray(order.items) ? order.items : [];
  const shopCodes = Object.keys(SHOPEE_SHOP_PROFILES);
  const itemEvidence = items.map((item) => ({
    name: String(item?.name || "").trim(),
    variant: String(item?.variant || "").trim(),
    matches: shopCodes.map((shopCode) => ({
      shopCode,
      ...publicProductMatch(matcher(shopCode, item)),
    })),
  }));
  const shops = shopCodes.map((shopCode) => {
    const matches = itemEvidence.map((item) => (
      item.matches.find((match) => match.shopCode === shopCode)
    ));
    const recognizedItems = matches.filter((match) => match?.status !== "unmapped").length;
    const manualReviewRequired = matches.some((match) => (
      match?.status === "unmapped"
      || match?.status === "visibility_only"
      || (match?.status === "bundle" && match.quantityRuleStatus !== "verified")
    ));
    return {
      shopCode,
      recognizedItems,
      totalItems: items.length,
      coverageComplete: items.length > 0 && recognizedItems === items.length,
      manualReviewRequired,
    };
  });
  const complete = shops.filter((shop) => shop.coverageComplete);
  const partial = shops.filter((shop) => shop.recognizedItems > 0);
  let evidenceStatus = "product_unknown";
  let suggestedShopCode = null;
  let candidateShopCode = null;
  if (complete.length === 1) {
    evidenceStatus = "product_match";
    suggestedShopCode = complete[0].shopCode;
  } else if (complete.length > 1 || partial.length > 1) {
    evidenceStatus = "product_conflict";
  } else if (partial.length === 1) {
    evidenceStatus = "product_partial";
    candidateShopCode = partial[0].shopCode;
  }

  return {
    catalogVersion: getShopeeProductCatalogSummary().catalogVersion,
    candidateShopCode,
    evidenceStatus,
    items: itemEvidence,
    shops,
    suggestedShopCode,
  };
}

function combineLegacyEvidence(recipientEvidence, productEvidence) {
  const recipientShop = recipientEvidence.suggestedShopCode;
  const productShop = productEvidence.suggestedShopCode;
  let recommendationStatus = "unknown";
  let suggestedShopCode = null;
  if (recipientShop && productShop && recipientShop !== productShop) {
    recommendationStatus = "evidence_conflict";
  } else if (recipientShop && productShop) {
    recommendationStatus = "evidence_agrees";
    suggestedShopCode = recipientShop;
  } else if (recipientShop) {
    recommendationStatus = "recipient_only";
    suggestedShopCode = recipientShop;
  } else if (productShop) {
    recommendationStatus = "product_only";
    suggestedShopCode = productShop;
  }
  return {
    ...recipientEvidence,
    productEvidence,
    recommendationStatus,
    suggestedShopCode,
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
    const recipientEvidence = await resolveLegacyRoutingEvidence(order, evidenceDependencies);
    const productEvidence = resolveLegacyProductEvidence(order, dependencies);
    const evidence = combineLegacyEvidence(recipientEvidence, productEvidence);
    return publicOrder(order, evidence);
  });
  return { ...result, orders };
}

async function reviewLegacyOrder({ orderNumber, selectedShopCode }, dependencies = {}) {
  const activeRepository = dependencies.repository || repository;
  const shopCode = requireShopeeShopCode(selectedShopCode);
  const order = await activeRepository.getLegacyOrder(orderNumber);
  const recipientEvidence = await resolveLegacyRoutingEvidence(order, dependencies);
  const productEvidence = resolveLegacyProductEvidence(order, dependencies);
  const evidence = combineLegacyEvidence(recipientEvidence, productEvidence);
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
  combineLegacyEvidence,
  resolveLegacyProductEvidence,
  resolveLegacyRoutingEvidence,
  reviewLegacyOrder,
};
