jest.mock("../db", () => ({
  connect: jest.fn(),
  query: jest.fn(),
}));

const pool = require("../db");
const catalog = require("../src/modules/seamless/data/shopeeProductCatalog.v1.json");
const {
  getOrderTimeline,
  listOrders,
  listOrdersForSalesSummary,
  mapEvent,
  mapOrder,
  upsertOrderEvent,
  withShopeeOrderSyncLock,
} = require("../src/modules/seamless/db/shopeeOrderRepository");

const CANONICAL_KEY = `sha256:${"a".repeat(64)}`;
const ORDER_NUMBER = "26082471YK8C02";
const CATALOG_VERSION = "shopee-company-sku-2026-08-28";
const databaseOrder = {
  current_status: "shipment_due",
  delivery_method: "Standard Delivery - ส่งธรรมดาในประเทศ",
  event_count: "2",
  first_event_at: new Date("2026-08-24T02:00:00.000Z"),
  item_count: 1,
  item_subtotal: "70.00",
  items: [{ name: "สินค้าทดสอบ", quantity: 1, unitPrice: 70, variant: "1 ขวด" }],
  last_event_at: new Date("2026-08-24T03:00:00.000Z"),
  ordered_at: new Date("2026-08-24T01:00:00.000Z"),
  order_number: ORDER_NUMBER,
  shipping_deadline: "2026-08-30",
  shipping_fee: "38.00",
  shop_code: "sc-drug-store",
  total_amount: "108.00",
  total_quantity: 1,
};

function parsedEvent(overrides = {}) {
  return {
    event: {
      canonicalMessageKey: CANONICAL_KEY,
      details: { shippingDeadline: "2026-08-30" },
      eventType: "shipment_due",
      gmailMessageId: "gmail-1",
      gmailThreadId: "thread-1",
      mailboxAccount: "admin@scgroup1989.com",
      occurredAt: "2026-08-24T03:00:00.000Z",
      orderNumber: ORDER_NUMBER,
      shopCode: "sc-drug-store",
      ...overrides.event,
    },
    order: {
      currentStatus: "shipment_due",
      deliveryMethod: databaseOrder.delivery_method,
      firstEventAt: "2026-08-24T02:00:00.000Z",
      itemSubtotal: 70,
      items: databaseOrder.items,
      lastEventAt: "2026-08-24T03:00:00.000Z",
      orderedAt: "2026-08-24T01:00:00.000Z",
      orderNumber: ORDER_NUMBER,
      shippingDeadline: "2026-08-30",
      shippingFee: 38,
      shopCode: "sc-drug-store",
      totalAmount: 108,
      ...overrides.order,
    },
  };
}

function successfulClient(orderRow = databaseOrder) {
  return {
    query: jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [orderRow] })
      .mockResolvedValueOnce({ rows: [{ id: "event-1" }] }),
  };
}

test("maps PostgreSQL values to the bounded, shop-scoped public timeline contract", () => {
  expect(mapOrder(databaseOrder)).toEqual({
    currentStatus: "shipment_due",
    deliveryMethod: "Standard Delivery - ส่งธรรมดาในประเทศ",
    eventCount: 2,
    firstEventAt: "2026-08-24T02:00:00.000Z",
    itemCount: 1,
    itemSubtotal: 70,
    items: [{
      ...databaseOrder.items[0],
      productMatch: {
        catalogVersion: CATALOG_VERSION,
        status: "unmapped",
        reasonCode: "catalog_identity_not_found",
      },
    }],
    lastEventAt: "2026-08-24T03:00:00.000Z",
    orderedAt: "2026-08-24T01:00:00.000Z",
    orderNumber: ORDER_NUMBER,
    productMapping: {
      catalogVersion: CATALOG_VERSION,
      totalItems: 1,
      matchedItems: 0,
      bundleItems: 0,
      visibilityOnlyItems: 0,
      unmappedItems: 1,
      coverageComplete: false,
      manualReviewRequired: true,
    },
    shippingDeadline: "2026-08-30",
    shippingFee: 38,
    shopCode: "sc-drug-store",
    totalAmount: 108,
    totalQuantity: 1,
  });
  expect(mapEvent({
    details: { shippingDeadline: "2026-08-30" },
    event_type: "shipment_due",
    id: "event-1",
    occurred_at: databaseOrder.last_event_at,
    shop_code: "sc-drug-store",
  })).toEqual({
    details: { shippingDeadline: "2026-08-30" },
    eventType: "shipment_due",
    id: "event-1",
    occurredAt: "2026-08-24T03:00:00.000Z",
    shopCode: "sc-drug-store",
  });
});

test("strips unexpected JSONB fields at the repository egress boundary", () => {
  const mappedOrder = mapOrder({
    ...databaseOrder,
    items: [{
      ...databaseOrder.items[0],
      buyerUsername: "private_buyer",
      recipientName: "Private Recipient",
      rawBody: "private raw email",
    }],
  });
  const mappedEvent = mapEvent({
    details: {
      cancellationReasonCode: "shipping_deadline_missed",
      recipientName: "Private Recipient",
      subject: "private subject",
    },
    event_type: "order_cancelled",
    id: "event-1",
    occurred_at: databaseOrder.last_event_at,
    shop_code: "sc-drug-store",
  });

  expect(mappedOrder.items).toEqual([{
    ...databaseOrder.items[0],
    productMatch: {
      catalogVersion: CATALOG_VERSION,
      status: "unmapped",
      reasonCode: "catalog_identity_not_found",
    },
  }]);
  expect(mappedEvent.details).toEqual({ cancellationReasonCode: "shipping_deadline_missed" });
  expect(JSON.stringify({ mappedEvent, mappedOrder })).not.toMatch(/private|subject|recipient|rawBody/iu);
});

test("enriches persisted email items with the corrected Company SKU at API egress", () => {
  const catalogRecord = catalog.records.find((record) => (
    record.shopCode === "sc-drug-store" && record.sourceRow === 33
  ));
  const mappedOrder = mapOrder({
    ...databaseOrder,
    items: [{
      name: catalogRecord.productName,
      quantity: 6,
      unitPrice: 90,
      variant: catalogRecord.variant,
    }],
  });

  expect(mappedOrder.items[0].productMatch).toMatchObject({
    catalogVersion: CATALOG_VERSION,
    status: "matched",
    companySku: "IC-001849",
    listingProductId: "56562041161",
    listingVariationId: "436046531380",
  });
  expect(mappedOrder.productMapping).toMatchObject({
    totalItems: 1,
    matchedItems: 1,
    coverageComplete: true,
    manualReviewRequired: false,
  });
});

test.each([
  "• ข้อมูลผู้ซื้อ: Private Buyer",
  "- ข้อมูลผู้รับ: Private Recipient",
  "▪ ที่อยู่สำหรับจัดส่ง: Private Address",
  "1) เบอร์โทรมือถือ: 0812345678",
  "(1) หมายเลขโทรศัพท์มือถือ: 0898765432",
])("fails persistence closed for sensitive item label: %s", async (sensitiveLabel) => {
  const client = successfulClient({ ...databaseOrder, items: [] });
  await upsertOrderEvent(parsedEvent({
    order: {
      items: [
        databaseOrder.items[0],
        { name: sensitiveLabel, quantity: 1, unitPrice: 70, variant: "" },
      ],
    },
  }), client);

  expect(JSON.parse(client.query.mock.calls[2][1][5])).toEqual([]);
  expect(JSON.stringify(client.query.mock.calls.map((call) => call[1])))
    .not.toMatch(/private buyer|private recipient|private address|0812345678|0898765432/iu);
});

test("upserts a composite shop/order and canonical event without raw email or buyer fields", async () => {
  const client = successfulClient();
  const parsed = parsedEvent({
    event: { details: { shippingDeadline: "2026-08-30", subject: "private subject" } },
    order: { items: [{ ...databaseOrder.items[0], recipientName: "Private Recipient" }] },
  });

  const result = await upsertOrderEvent(parsed, client);

  expect(result.eventCreated).toBe(true);
  expect(client.query).toHaveBeenCalledTimes(4);
  expect(client.query.mock.calls[0][0]).toContain("pg_advisory_xact_lock");
  expect(client.query.mock.calls[2][0]).toContain("ON CONFLICT (shop_code, order_number)");
  expect(client.query.mock.calls[3][0]).toContain("canonical_message_key");
  expect(client.query.mock.calls[3][0]).toContain("ON CONFLICT DO NOTHING");
  const persistedValues = JSON.stringify(client.query.mock.calls.map((call) => call[1]));
  expect(persistedValues).not.toMatch(/subject|body|buyer|username|phone|address|recipient|private/iu);
});

test("deduplicates a forwarded canonical email before mutating another shop order", async () => {
  const client = {
    query: jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ order_number: ORDER_NUMBER, shop_code: "sc-drug-store" }] }),
  };
  const result = await upsertOrderEvent(parsedEvent({
    event: {
      gmailMessageId: "forwarded-gmail-id",
      mailboxAccount: "second-mailbox@example.invalid",
      shopCode: "dr-morepen",
    },
    order: { shopCode: "dr-morepen" },
  }), client);

  expect(result).toMatchObject({
    duplicateShopCode: "sc-drug-store",
    eventCreated: false,
    order: null,
  });
  expect(client.query).toHaveBeenCalledTimes(2);
});

test("rejects missing/mismatched shop, order, or canonical identity before persistence", async () => {
  const client = { query: jest.fn() };
  await expect(upsertOrderEvent(parsedEvent({
    order: { shopCode: "" },
  }), client)).rejects.toThrow("shopCode is required");
  await expect(upsertOrderEvent(parsedEvent({
    event: { shopCode: "dr-morepen" },
  }), client)).rejects.toThrow("same valid shop and order number");
  await expect(upsertOrderEvent(parsedEvent({
    event: { orderNumber: "26082471YK8C03" },
  }), client)).rejects.toThrow("same valid shop and order number");
  await expect(upsertOrderEvent(parsedEvent({
    event: { canonicalMessageKey: "gmail-1" },
  }), client)).rejects.toThrow("canonicalMessageKey");
  expect(client.query).not.toHaveBeenCalled();
});

test("list/detail SQL binds shopCode in every order and event lookup", async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [databaseOrder] })
    .mockResolvedValueOnce({ rows: [databaseOrder] })
    .mockResolvedValueOnce({ rows: [{
      details: {}, event_type: "shipment_due", id: "event-1",
      occurred_at: databaseOrder.last_event_at, shop_code: "sc-drug-store",
    }] });

  await listOrders({ limit: 25, shopCode: "sc-drug-store" });
  await getOrderTimeline("sc-drug-store", ORDER_NUMBER);

  expect(pool.query.mock.calls[0][0]).toContain("o.shop_code = $1");
  expect(pool.query.mock.calls[0][1][0]).toBe("sc-drug-store");
  expect(pool.query.mock.calls[1][0]).toContain("o.shop_code = $1 AND o.order_number = $2");
  expect(pool.query.mock.calls[2][0]).toContain("shop_code = $1 AND order_number = $2");
  expect(pool.query.mock.calls[1][1]).toEqual(["sc-drug-store", ORDER_NUMBER]);
  expect(pool.query.mock.calls[2][1]).toEqual(["sc-drug-store", ORDER_NUMBER]);
});

test("all-shops list includes only supported shops and paginates by composite identity", async () => {
  pool.query.mockClear();
  pool.query
    .mockResolvedValueOnce({ rows: [databaseOrder] })
    .mockResolvedValueOnce({ rows: [] });

  await listOrders({ limit: 25, shopCode: "all" });
  await listOrders({
    cursor: {
      lastEventAt: "2026-08-24T03:00:00.000Z",
      orderNumber: ORDER_NUMBER,
      rowShopCode: "sc-drug-store",
      shopCode: "all",
    },
    limit: 10,
    shopCode: "all",
    status: "shipment_due",
  });

  const [firstSql, firstParams] = pool.query.mock.calls[0];
  expect(firstSql).toContain("o.shop_code = ANY($1::text[])");
  expect(firstSql).toContain("ORDER BY o.last_event_at DESC, o.shop_code DESC, o.order_number DESC");
  expect(firstParams[0]).toEqual(["sc-drug-store", "dr-morepen"]);
  expect(firstParams).not.toContain("legacy-unattributed");

  const [pageSql, pageParams] = pool.query.mock.calls[1];
  expect(pageSql).toContain("(o.last_event_at, o.shop_code, o.order_number) <");
  expect(pageParams).toEqual([
    ["sc-drug-store", "dr-morepen"],
    "shipment_due",
    "2026-08-24T03:00:00.000Z",
    "sc-drug-store",
    ORDER_NUMBER,
    11,
  ]);
});

test("numbered pagination returns a total and applies allowlisted document sorting", async () => {
  pool.query.mockClear();
  pool.query.mockResolvedValueOnce({
    rows: [{ ...databaseOrder, total_count: "51" }],
  });

  const result = await listOrders({
    limit: 25,
    page: 2,
    shopCode: "all",
    sortBy: "orderNumber",
    sortOrder: "asc",
  });

  expect(result).toMatchObject({ hasMore: true, totalCount: 51 });
  expect(result.orders).toHaveLength(1);
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toContain("WITH total AS");
  expect(sql).toContain("LEFT JOIN page_rows ON TRUE");
  expect(sql).toContain("ORDER BY o.order_number ASC, o.shop_code ASC, o.last_event_at ASC");
  expect(sql).toContain("LIMIT $2");
  expect(sql).toContain("OFFSET $3");
  expect(params).toEqual([["sc-drug-store", "dr-morepen"], 25, 25]);
});

test("sales summary query uses inclusive Bangkok dates and excludes cancelled or returned orders", async () => {
  pool.query.mockClear();
  pool.query.mockResolvedValueOnce({ rows: [databaseOrder] });

  const orders = await listOrdersForSalesSummary({
    endDate: "2026-08-25",
    shopCode: "all",
    startDate: "2026-08-24",
  });

  expect(orders).toHaveLength(1);
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toContain("o.shop_code = ANY($1::text[])");
  expect(sql).toContain("AT TIME ZONE 'Asia/Bangkok'");
  expect(sql).toContain("o.current_status IN ('order_confirmed', 'shipment_due')");
  expect(sql).toContain("jsonb_array_length(o.items) > 0");
  expect(params).toEqual([
    ["sc-drug-store", "dr-morepen"],
    "2026-08-24",
    "2026-08-25",
  ]);
});

test("uses a non-blocking shop+mailbox lock and rejects a concurrent same-shop sync", async () => {
  let enterFirstSync;
  const firstStarted = new Promise((resolve) => { enterFirstSync = resolve; });
  let finishFirstSync;
  const firstCompletion = new Promise((resolve) => { finishFirstSync = resolve; });
  const firstClient = {
    query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ unlocked: true }] }),
    release: jest.fn(),
  };
  const secondClient = {
    query: jest.fn().mockResolvedValueOnce({ rows: [{ acquired: false }] }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValueOnce(firstClient).mockResolvedValueOnce(secondClient);

  const firstSync = withShopeeOrderSyncLock(
    "sc-drug-store",
    "Admin@SCGroup1989.com",
    async () => {
      enterFirstSync();
      return firstCompletion;
    },
  );
  await firstStarted;
  await expect(withShopeeOrderSyncLock(
    "sc-drug-store",
    "admin@scgroup1989.com",
    async () => "never",
  )).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });

  finishFirstSync("complete");
  await expect(firstSync).resolves.toBe("complete");
  expect(firstClient.query.mock.calls[0][1]).toEqual([
    "shopee-order-timeline-sync:sc-drug-store:admin@scgroup1989.com",
  ]);
  expect(firstClient.release).toHaveBeenCalledTimes(1);
  expect(secondClient.release).toHaveBeenCalledTimes(1);
});

test("releases or destroys the session client after callback/unlock failures", async () => {
  const callbackFailure = new Error("database write failed");
  const callbackClient = {
    query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ unlocked: true }] }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValueOnce(callbackClient);
  await expect(withShopeeOrderSyncLock(
    "sc-drug-store",
    "admin@scgroup1989.com",
    async () => { throw callbackFailure; },
  )).rejects.toBe(callbackFailure);
  expect(callbackClient.release).toHaveBeenCalledTimes(1);

  const unlockFailure = new Error("connection lost before unlock confirmation");
  const unlockClient = {
    query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockRejectedValueOnce(unlockFailure),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValueOnce(unlockClient);
  await expect(withShopeeOrderSyncLock(
    "sc-drug-store",
    "admin@scgroup1989.com",
    async () => "complete",
  )).rejects.toBe(unlockFailure);
  expect(unlockClient.release).toHaveBeenCalledWith(unlockFailure);
});
