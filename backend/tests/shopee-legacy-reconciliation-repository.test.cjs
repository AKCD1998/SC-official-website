jest.mock("../db", () => ({ query: jest.fn() }));

const pool = require("../db");
const repository = require(
  "../src/modules/seamless/db/shopeeLegacyReconciliationRepository",
);

const ORDER_NUMBER = "26082471YK8C02";
const legacyRow = {
  current_status: "shipment_due",
  decision_status: null,
  evidence_status: null,
  event_count: "1",
  first_event_at: new Date("2026-08-24T02:00:00.000Z"),
  last_event_at: new Date("2026-08-24T03:00:00.000Z"),
  order_number: ORDER_NUMBER,
  reviewed_at: null,
  selected_shop_code: null,
  source_events: [{
    eventType: "shipment_due",
    gmailMessageId: "gmail-private-id",
    mailboxAccount: "mailbox@example.invalid",
    occurredAt: "2026-08-24T03:00:00.000Z",
  }],
  suggested_shop_code: null,
};

beforeEach(() => jest.clearAllMocks());

test("lists quarantined orders with bounded pagination and decision status", async () => {
  pool.query.mockResolvedValueOnce({ rows: [legacyRow, { ...legacyRow, order_number: "26082471YK8C03" }] });

  const result = await repository.listLegacyOrders({ limit: 1, status: "pending" });

  expect(result.hasMore).toBe(true);
  expect(result.orders).toHaveLength(1);
  expect(result.orders[0]).toMatchObject({
    decision: null,
    eventCount: 1,
    orderNumber: ORDER_NUMBER,
  });
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toContain("o.shop_code = 'legacy-unattributed'");
  expect(sql).toContain("d.order_number IS NULL");
  expect(sql).toContain("ORDER BY o.last_event_at DESC, o.order_number DESC");
  expect(params).toEqual([2]);
});

test("saves a review-only shop choice without updating legacy order/event tables", async () => {
  pool.query.mockResolvedValueOnce({ rows: [{
    decision_status: "reviewed",
    evidence_status: "recipient_match",
    order_number: ORDER_NUMBER,
    reviewed_at: new Date("2026-08-28T04:00:00.000Z"),
    selected_shop_code: "dr-morepen",
    suggested_shop_code: "dr-morepen",
  }] });

  const decision = await repository.saveDecision({
    evidenceStatus: "recipient_match",
    orderNumber: ORDER_NUMBER,
    selectedShopCode: "dr-morepen",
    suggestedShopCode: "dr-morepen",
  });

  expect(decision).toMatchObject({
    decisionStatus: "reviewed",
    orderNumber: ORDER_NUMBER,
    selectedShopCode: "dr-morepen",
  });
  const [sql] = pool.query.mock.calls[0];
  expect(sql).toContain("shopee_legacy_reconciliation_decisions");
  expect(sql).not.toMatch(/UPDATE\s+[^\n]*shopee_(orders|order_events)/iu);
  expect(sql).toContain("o.shop_code = $1");
});

test("dry-runs target collisions without changing order or event rows", async () => {
  pool.query.mockResolvedValueOnce({ rows: [{
    order_number: ORDER_NUMBER,
    target_shop_code: "sc-drug-store",
  }] });

  const result = await repository.inspectLegacyApplyTargets([{
    orderNumber: ORDER_NUMBER,
    targetShopCode: "sc-drug-store",
  }]);

  expect(result).toEqual([{
    orderNumber: ORDER_NUMBER,
    targetShopCode: "sc-drug-store",
  }]);
  const [sql] = pool.query.mock.calls[0];
  expect(sql).toContain('JOIN "clasp_scx_seamless"."shopee_orders" target');
  expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/iu);
});
