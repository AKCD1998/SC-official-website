jest.mock("../src/modules/seamless/db/shopeeLegacyReconciliationRepository", () => ({}));

const {
  combineLegacyEvidence,
  listLegacyReconciliationPage,
  resolveLegacyMailboxEvidence,
  resolveLegacyProductEvidence,
  resolveLegacyRoutingEvidence,
  reviewLegacyOrder,
} = require("../src/modules/seamless/services/shopeeLegacyReconciliationService");

const ORDER_NUMBER = "26082471YK8C02";
const configs = [{
  expectedMailbox: "admin@sc.example",
  mailboxAccount: "legacy@archive.example",
  shopCode: "sc-drug-store",
}, {
  expectedMailbox: "orders@morepen.example",
  mailboxAccount: "morepen@archive.example",
  shopCode: "dr-morepen",
}];
const pinnedConfigs = [{
  expectedMailbox: "admin@sc.example",
  mailboxAccount: "admin@sc.example",
  shopCode: "sc-drug-store",
}, {
  expectedMailbox: "orders@morepen.example",
  mailboxAccount: "orders@morepen.example",
  shopCode: "dr-morepen",
}];

function message(id, to, from = "Shopee <info@mail.shopee.co.th>") {
  return {
    id,
    internalDate: "1787549837000",
    payload: { headers: [
      { name: "From", value: from },
      { name: "To", value: to },
    ] },
  };
}

function legacyOrder(events = [{
  gmailMessageId: "gmail-private-id",
  mailboxAccount: "legacy@archive.example",
}]) {
  return {
    currentStatus: "shipment_due",
    decision: null,
    eventCount: events.length,
    firstEventAt: "2026-08-24T02:00:00.000Z",
    lastEventAt: "2026-08-24T03:00:00.000Z",
    orderNumber: ORDER_NUMBER,
    sourceEvents: events,
  };
}

test("suggests a shop from live From/To metadata without returning raw routing identifiers", async () => {
  const order = legacyOrder();
  const evidence = await resolveLegacyRoutingEvidence(order, {
    configs,
    createAdapter: () => ({
      getMessageRoutingMetadata: async () => message(
        "gmail-private-id",
        "DR Orders <orders@morepen.example>",
      ),
    }),
  });

  expect(evidence).toEqual({
    evidenceStatus: "recipient_match",
    matchedEventCount: 1,
    suggestedShopCode: "dr-morepen",
    totalEventCount: 1,
  });

  const repository = { listLegacyOrders: jest.fn(async () => ({ hasMore: false, orders: [order] })) };
  const page = await listLegacyReconciliationPage({ limit: 10 }, {
    configs,
    createAdapter: () => ({
      getMessageRoutingMetadata: async () => message("gmail-private-id", "admin@sc.example"),
    }),
    repository,
  });
  expect(page.orders[0].evidence.suggestedShopCode).toBe("sc-drug-store");
  expect(JSON.stringify(page)).not.toMatch(/gmail-private-id|archive\.example|admin@sc\.example/iu);
});

test("fails closed on conflicting recipient evidence but still permits an explicit admin choice", async () => {
  const order = legacyOrder([{ gmailMessageId: "one", mailboxAccount: "legacy@archive.example" }, {
    gmailMessageId: "two",
    mailboxAccount: "legacy@archive.example",
  }]);
  const routing = {
    one: message("one", "admin@sc.example"),
    two: message("two", "orders@morepen.example"),
  };
  const saveDecision = jest.fn(async (decision) => ({ ...decision, decisionStatus: "reviewed" }));
  const result = await reviewLegacyOrder({
    orderNumber: ORDER_NUMBER,
    selectedShopCode: "sc-drug-store",
  }, {
    configs,
    createAdapter: () => ({ getMessageRoutingMetadata: async (id) => routing[id] }),
    repository: {
      getLegacyOrder: jest.fn(async () => order),
      saveDecision,
    },
  });

  expect(result.reviewOnly).toBe(true);
  expect(result.evidence).toMatchObject({
    evidenceStatus: "recipient_conflict",
    suggestedShopCode: null,
  });
  expect(saveDecision).toHaveBeenCalledWith(expect.objectContaining({
    evidenceStatus: "recipient_conflict",
    selectedShopCode: "sc-drug-store",
    suggestedShopCode: null,
  }));
});

test("uses complete exact product coverage as a shop suggestion without applying a decision", () => {
  const productEvidence = resolveLegacyProductEvidence({
    items: [{ name: "SC-only product", variant: "80 g" }],
  }, {
    matchProduct: (shopCode) => shopCode === "sc-drug-store"
      ? { status: "matched", companySku: "IC-000001" }
      : { status: "unmapped", reasonCode: "catalog_identity_not_found" },
  });

  expect(productEvidence).toMatchObject({
    evidenceStatus: "product_match",
    suggestedShopCode: "sc-drug-store",
    shops: expect.arrayContaining([
      expect.objectContaining({ shopCode: "sc-drug-store", coverageComplete: true }),
      expect.objectContaining({ shopCode: "dr-morepen", coverageComplete: false }),
    ]),
  });
  expect(productEvidence.items[0]).toMatchObject({
    name: "SC-only product",
    matches: expect.arrayContaining([
      expect.objectContaining({ companySku: "IC-000001", shopCode: "sc-drug-store" }),
    ]),
  });
});

test("does not recommend a shop when recipient and product evidence conflict", () => {
  const combined = combineLegacyEvidence({
    evidenceStatus: "recipient_match",
    matchedEventCount: 1,
    suggestedShopCode: "dr-morepen",
    totalEventCount: 1,
  }, {
    evidenceStatus: "product_match",
    suggestedShopCode: "sc-drug-store",
  });
  expect(combined).toMatchObject({
    recommendationStatus: "evidence_conflict",
    suggestedShopCode: null,
  });
});

test("keeps partial or ambiguous product evidence review-only", () => {
  const productEvidence = resolveLegacyProductEvidence({
    items: [{ name: "known", variant: "" }, { name: "unknown", variant: "" }],
  }, {
    matchProduct: (shopCode, item) => shopCode === "dr-morepen" && item.name === "known"
      ? { status: "matched", companySku: "IC-000002" }
      : { status: "unmapped", reasonCode: "catalog_identity_not_found" },
  });
  expect(productEvidence).toMatchObject({
    candidateShopCode: "dr-morepen",
    evidenceStatus: "product_partial",
    suggestedShopCode: null,
  });
});

test("auto-classifies an order when every source event comes from one pinned mailbox", () => {
  const mailboxEvidence = resolveLegacyMailboxEvidence(legacyOrder([{
    gmailMessageId: "one",
    mailboxAccount: "orders@morepen.example",
  }, {
    gmailMessageId: "two",
    mailboxAccount: "ORDERS@MOREPEN.EXAMPLE",
  }]), { configs: pinnedConfigs });

  expect(mailboxEvidence).toEqual({
    distinctShopCount: 1,
    evidenceStatus: "mailbox_match",
    matchedEventCount: 2,
    suggestedShopCode: "dr-morepen",
    totalEventCount: 2,
  });

  const combined = combineLegacyEvidence({
    evidenceStatus: "recipient_unknown",
    matchedEventCount: 0,
    suggestedShopCode: null,
    totalEventCount: 2,
  }, {
    candidateShopCode: null,
    evidenceStatus: "product_unknown",
    suggestedShopCode: null,
  }, mailboxEvidence);

  expect(combined).toMatchObject({
    classification: {
      reasonCode: "trusted_mailbox",
      requiresConfirmation: false,
      shopCode: "dr-morepen",
      status: "auto_classified",
    },
    recommendationStatus: "auto_classified",
    suggestedShopCode: "dr-morepen",
  });
  expect(JSON.stringify(combined)).not.toMatch(/orders@morepen\.example/iu);
});

test("requires manual review when source events span both pinned mailboxes", () => {
  const mailboxEvidence = resolveLegacyMailboxEvidence(legacyOrder([{
    gmailMessageId: "one",
    mailboxAccount: "admin@sc.example",
  }, {
    gmailMessageId: "two",
    mailboxAccount: "orders@morepen.example",
  }]), { configs: pinnedConfigs });
  const combined = combineLegacyEvidence({
    evidenceStatus: "recipient_unknown",
    suggestedShopCode: null,
  }, {
    evidenceStatus: "product_unknown",
    suggestedShopCode: null,
  }, mailboxEvidence);

  expect(mailboxEvidence).toMatchObject({
    evidenceStatus: "mailbox_conflict",
    suggestedShopCode: null,
  });
  expect(combined).toMatchObject({
    classification: {
      reasonCode: "evidence_conflict",
      requiresConfirmation: true,
      shopCode: null,
      status: "manual_review",
    },
    suggestedShopCode: null,
  });
});

test("fails closed when partial product evidence points away from the pinned mailbox", () => {
  const combined = combineLegacyEvidence({
    evidenceStatus: "recipient_unknown",
    suggestedShopCode: null,
  }, {
    candidateShopCode: "dr-morepen",
    evidenceStatus: "product_partial",
    suggestedShopCode: null,
  }, {
    evidenceStatus: "mailbox_match",
    suggestedShopCode: "sc-drug-store",
  });

  expect(combined).toMatchObject({
    classification: {
      reasonCode: "evidence_conflict",
      requiresConfirmation: true,
      status: "manual_review",
    },
    recommendationStatus: "evidence_conflict",
    suggestedShopCode: null,
  });
});
