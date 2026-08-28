const crypto = require("node:crypto");
const { readShopeeGmailConfigForShop } = require("../config");
const repository = require("../db/shopeeLegacyReconciliationRepository");
const orderRepository = require("../db/shopeeOrderRepository");
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
const LEGACY_APPLY_PLAN_LIMIT = 10_000;

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

function normalizeMailbox(value) {
  return String(value || "").trim().toLowerCase();
}

function resolveLegacyMailboxEvidence(order, dependencies = {}) {
  const configs = routingConfigs(dependencies);
  const shopByTrustedMailbox = new Map();
  configs.forEach((config) => {
    const mailboxAccount = normalizeMailbox(config.mailboxAccount);
    const expectedMailbox = normalizeMailbox(config.expectedMailbox);
    if (
      mailboxAccount
      && expectedMailbox
      && mailboxAccount === expectedMailbox
      && config.shopCode
    ) {
      shopByTrustedMailbox.set(mailboxAccount, config.shopCode);
    }
  });

  const events = Array.isArray(order.sourceEvents) ? order.sourceEvents : [];
  const matchedShopCodes = events.map((event) => (
    shopByTrustedMailbox.get(normalizeMailbox(event.mailboxAccount)) || null
  ));
  const candidates = new Set(matchedShopCodes.filter(Boolean));
  const matchedEventCount = matchedShopCodes.filter(Boolean).length;
  const hasUnknownMailbox = matchedEventCount !== events.length;
  let evidenceStatus = "mailbox_unknown";
  if (candidates.size > 1) evidenceStatus = "mailbox_conflict";
  else if (events.length && !hasUnknownMailbox && candidates.size === 1) {
    evidenceStatus = "mailbox_match";
  }

  return {
    distinctShopCount: candidates.size,
    evidenceStatus,
    matchedEventCount,
    suggestedShopCode: evidenceStatus === "mailbox_match" ? [...candidates][0] : null,
    totalEventCount: events.length,
  };
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

function combineLegacyEvidence(recipientEvidence, productEvidence, mailboxEvidence = {}) {
  const mailboxShop = mailboxEvidence.suggestedShopCode;
  const recipientShop = recipientEvidence.suggestedShopCode;
  const productShop = productEvidence.suggestedShopCode;
  const productCandidateShop = productEvidence.candidateShopCode;
  const strongCandidates = new Set([
    mailboxShop,
    recipientShop,
    productShop,
  ].filter(Boolean));
  const productCandidateConflicts = Boolean(
    productCandidateShop
    && [...strongCandidates].some((shopCode) => shopCode !== productCandidateShop),
  );
  const hasConflict = (
    strongCandidates.size > 1
    || productCandidateConflicts
    || mailboxEvidence.evidenceStatus === "mailbox_conflict"
    || recipientEvidence.evidenceStatus === "recipient_conflict"
    || productEvidence.evidenceStatus === "product_conflict"
  );
  let recommendationStatus = "unknown";
  let suggestedShopCode = null;
  let classification = {
    reasonCode: "trusted_mailbox_unavailable",
    requiresConfirmation: true,
    shopCode: null,
    status: "manual_review",
  };

  if (hasConflict) {
    recommendationStatus = "evidence_conflict";
    classification = {
      reasonCode: "evidence_conflict",
      requiresConfirmation: true,
      shopCode: null,
      status: "manual_review",
    };
  } else if (mailboxShop) {
    recommendationStatus = "auto_classified";
    suggestedShopCode = mailboxShop;
    classification = {
      reasonCode: "trusted_mailbox",
      requiresConfirmation: false,
      shopCode: mailboxShop,
      status: "auto_classified",
    };
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
    classification,
    mailboxEvidence,
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
    const mailboxEvidence = resolveLegacyMailboxEvidence(order, evidenceDependencies);
    const recipientEvidence = await resolveLegacyRoutingEvidence(order, evidenceDependencies);
    const productEvidence = resolveLegacyProductEvidence(order, dependencies);
    const evidence = combineLegacyEvidence(recipientEvidence, productEvidence, mailboxEvidence);
    return publicOrder(order, evidence);
  });
  return { ...result, orders };
}

async function reviewLegacyOrder({ orderNumber, selectedShopCode }, dependencies = {}) {
  const activeRepository = dependencies.repository || repository;
  const shopCode = requireShopeeShopCode(selectedShopCode);
  const order = await activeRepository.getLegacyOrder(orderNumber);
  const mailboxEvidence = resolveLegacyMailboxEvidence(order, dependencies);
  const recipientEvidence = await resolveLegacyRoutingEvidence(order, dependencies);
  const productEvidence = resolveLegacyProductEvidence(order, dependencies);
  const evidence = combineLegacyEvidence(recipientEvidence, productEvidence, mailboxEvidence);
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

function createApplyPlanDigest(attributions) {
  const stable = attributions.map((attribution) => ({
    decisionSource: attribution.decisionSource,
    evidenceStatus: attribution.evidenceStatus,
    eventCount: attribution.eventCount,
    lastEventAt: attribution.lastEventAt,
    orderNumber: attribution.orderNumber,
    targetShopCode: attribution.targetShopCode,
    targetOrderExisted: attribution.targetOrderExisted,
  })).sort((left, right) => left.orderNumber.localeCompare(right.orderNumber));
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

async function buildLegacyApplyPlan(dependencies = {}) {
  const activeRepository = dependencies.repository || repository;
  const result = await activeRepository.listLegacyOrders({
    limit: LEGACY_APPLY_PLAN_LIMIT,
    status: "all",
  });
  if (result.hasMore) throw new Error("Legacy apply plan exceeded the bounded order limit.");

  const attributions = [];
  const byShop = {};
  let automaticCount = 0;
  let reviewedCount = 0;
  let eventCount = 0;
  result.orders.forEach((order) => {
    const mailboxEvidence = resolveLegacyMailboxEvidence(order, dependencies);
    const productEvidence = resolveLegacyProductEvidence(order, dependencies);
    const evidence = combineLegacyEvidence({
      evidenceStatus: "recipient_unknown",
      matchedEventCount: 0,
      suggestedShopCode: null,
      totalEventCount: order.eventCount,
    }, productEvidence, mailboxEvidence);
    let attribution = null;
    if (evidence.classification.status === "auto_classified") {
      automaticCount += 1;
      attribution = {
        decisionSource: "automatic",
        evidenceStatus: "mailbox_match",
        eventCount: Number(order.eventCount || 0),
        lastEventAt: order.lastEventAt,
        orderNumber: order.orderNumber,
        targetShopCode: evidence.classification.shopCode,
      };
    } else if (order.decision?.decisionStatus === "reviewed") {
      reviewedCount += 1;
      attribution = {
        decisionSource: "manual",
        evidenceStatus: order.decision.evidenceStatus || "recipient_unknown",
        eventCount: Number(order.eventCount || 0),
        lastEventAt: order.lastEventAt,
        orderNumber: order.orderNumber,
        targetShopCode: order.decision.selectedShopCode,
      };
    }
    if (!attribution) return;
    attributions.push(attribution);
    byShop[attribution.targetShopCode] = (byShop[attribution.targetShopCode] || 0) + 1;
    eventCount += Number(order.eventCount || 0);
  });

  const manualReviewRequiredCount = result.orders.length - attributions.length;
  const existingTargets = await activeRepository.inspectLegacyApplyTargets(attributions);
  const existingTargetKeys = new Set(existingTargets.map((target) => (
    `${target.targetShopCode}:${target.orderNumber}`
  )));
  attributions.forEach((attribution) => {
    attribution.targetOrderExisted = existingTargetKeys.has(
      `${attribution.targetShopCode}:${attribution.orderNumber}`,
    );
  });
  const targetExistingOrderCount = existingTargets.length;
  return {
    attributions,
    automaticCount,
    byShop,
    eventCount,
    legacyOrderCount: result.orders.length,
    manualReviewRequiredCount,
    planDigest: createApplyPlanDigest(attributions),
    readyToApply: result.orders.length > 0 && manualReviewRequiredCount === 0,
    reviewedCount,
    targetExistingOrderCount,
    targetNewOrderCount: attributions.length - targetExistingOrderCount,
  };
}

function publicLegacyApplyPlan(plan) {
  return {
    automaticCount: plan.automaticCount,
    byShop: plan.byShop,
    eventCount: plan.eventCount,
    legacyOrderCount: plan.legacyOrderCount,
    manualReviewRequiredCount: plan.manualReviewRequiredCount,
    planDigest: plan.planDigest,
    readyToApply: plan.readyToApply,
    reviewedCount: plan.reviewedCount,
    targetExistingOrderCount: plan.targetExistingOrderCount,
    targetNewOrderCount: plan.targetNewOrderCount,
  };
}

async function withApplyShopLocks(attributions, callback, dependencies = {}) {
  const withSyncLock = dependencies.withSyncLock || orderRepository.withShopeeOrderSyncLock;
  const shops = [...new Set(attributions.map((attribution) => attribution.targetShopCode))].sort();
  async function acquire(index) {
    if (index >= shops.length) return callback();
    const shopCode = shops[index];
    const config = readShopeeGmailConfigForShop(shopCode);
    return withSyncLock(shopCode, config.mailboxAccount, () => acquire(index + 1));
  }
  return acquire(0);
}

async function applyLegacyPlan({ planDigest }, dependencies = {}) {
  const activeRepository = dependencies.repository || repository;
  const plan = await buildLegacyApplyPlan({ ...dependencies, repository: activeRepository });
  if (!plan.legacyOrderCount) {
    return {
      alreadyApplied: true,
      eventCount: 0,
      orderCount: 0,
      planDigest: plan.planDigest,
    };
  }
  if (!plan.readyToApply) {
    const error = new Error("Legacy orders still require manual review before timeline apply.");
    error.statusCode = 409;
    error.details = publicLegacyApplyPlan(plan);
    throw error;
  }
  if (String(planDigest || "").trim().toLowerCase() !== plan.planDigest) {
    const error = new Error("Legacy apply plan changed; run a new dry-run before applying.");
    error.statusCode = 409;
    throw error;
  }
  return withApplyShopLocks(plan.attributions, () => activeRepository.applyLegacyAttributions({
    attributions: plan.attributions,
    planDigest: plan.planDigest,
  }), dependencies);
}

module.exports = {
  ROUTING_METADATA_CONCURRENCY,
  applyLegacyPlan,
  buildLegacyApplyPlan,
  listLegacyReconciliationPage,
  mapWithConcurrency,
  publicLegacyApplyPlan,
  combineLegacyEvidence,
  resolveLegacyProductEvidence,
  resolveLegacyMailboxEvidence,
  resolveLegacyRoutingEvidence,
  reviewLegacyOrder,
};
