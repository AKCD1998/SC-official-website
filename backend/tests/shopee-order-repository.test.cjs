jest.mock("../db", () => ({
  connect: jest.fn(),
  query: jest.fn(),
}));

const pool = require("../db");
const {
  mapEvent,
  mapOrder,
  upsertOrderEvent,
  withShopeeOrderSyncLock,
} = require("../src/modules/seamless/db/shopeeOrderRepository");

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
  order_number: "26082471YK8C02",
  shipping_deadline: "2026-08-30",
  shipping_fee: "38.00",
  total_amount: "108.00",
  total_quantity: 1,
};

const SENSITIVE_ITEM_LABEL_CASES = [
  "• ข้อมูลผู้ซื้อ: Private Buyer",
  "- ข้อมูลผู้รับ: Private Recipient",
  "▪ ที่อยู่สำหรับจัดส่ง: Private Address",
  "1) เบอร์โทรมือถือ: 0812345678",
  "(1) หมายเลขโทรศัพท์มือถือ: 0898765432",
];

test("maps PostgreSQL values to the bounded public timeline contract", () => {
  expect(mapOrder(databaseOrder)).toEqual({
    currentStatus: "shipment_due",
    deliveryMethod: "Standard Delivery - ส่งธรรมดาในประเทศ",
    eventCount: 2,
    firstEventAt: "2026-08-24T02:00:00.000Z",
    itemCount: 1,
    itemSubtotal: 70,
    items: databaseOrder.items,
    lastEventAt: "2026-08-24T03:00:00.000Z",
    orderedAt: "2026-08-24T01:00:00.000Z",
    orderNumber: "26082471YK8C02",
    shippingDeadline: "2026-08-30",
    shippingFee: 38,
    totalAmount: 108,
    totalQuantity: 1,
  });
  expect(mapEvent({
    details: { shippingDeadline: "2026-08-30" },
    event_type: "shipment_due",
    id: "event-1",
    occurred_at: databaseOrder.last_event_at,
  })).toEqual({
    details: { shippingDeadline: "2026-08-30" },
    eventType: "shipment_due",
    id: "event-1",
    occurredAt: "2026-08-24T03:00:00.000Z",
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
  });

  expect(mappedOrder.items).toEqual(databaseOrder.items);
  expect(mappedEvent.details).toEqual({ cancellationReasonCode: "shipping_deadline_missed" });
  expect(JSON.stringify({ mappedEvent, mappedOrder })).not.toMatch(/private|subject|recipient|rawBody/iu);
});

test.each(SENSITIVE_ITEM_LABEL_CASES)(
  "fails persistence and API egress closed for sensitive item label: %s",
  async (sensitiveLabel) => {
    const items = [
      databaseOrder.items[0],
      { name: sensitiveLabel, quantity: 1, unitPrice: 70, variant: "" },
    ];
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ ...databaseOrder, items: [] }] })
        .mockResolvedValueOnce({ rows: [{ id: "event-sensitive" }] }),
    };
    const parsed = {
      order: {
        currentStatus: "shipment_due",
        firstEventAt: "2026-08-24T02:00:00.000Z",
        items,
        lastEventAt: "2026-08-24T03:00:00.000Z",
        orderNumber: databaseOrder.order_number,
      },
      event: {
        details: {},
        eventType: "shipment_due",
        gmailMessageId: "gmail-sensitive",
        mailboxAccount: "admin@scgroup1989.com",
        occurredAt: "2026-08-24T03:00:00.000Z",
        orderNumber: databaseOrder.order_number,
      },
    };

    await upsertOrderEvent(parsed, client);

    expect(JSON.parse(client.query.mock.calls[0][1][4])).toEqual([]);
    expect(mapOrder({ ...databaseOrder, items }).items).toEqual([]);
    expect(JSON.stringify(client.query.mock.calls.map((call) => call[1])))
      .not.toMatch(/private buyer|private recipient|private address|0812345678|0898765432/iu);
  },
);

test("upserts one order and idempotent Gmail event without raw email or buyer fields", async () => {
  const client = {
    query: jest.fn()
      .mockResolvedValueOnce({ rows: [databaseOrder] })
      .mockResolvedValueOnce({ rows: [{ id: "event-1" }] }),
  };
  const parsed = {
    order: {
      currentStatus: "shipment_due",
      deliveryMethod: databaseOrder.delivery_method,
      firstEventAt: "2026-08-24T02:00:00.000Z",
      itemCount: 1,
      itemSubtotal: 70,
      items: [{
        ...databaseOrder.items[0],
        recipientName: "Private Recipient",
        rawBody: "private raw email",
      }],
      lastEventAt: "2026-08-24T03:00:00.000Z",
      orderedAt: "2026-08-24T01:00:00.000Z",
      orderNumber: databaseOrder.order_number,
      shippingDeadline: "2026-08-30",
      shippingFee: 38,
      totalAmount: 108,
      totalQuantity: 1,
    },
    event: {
      details: {
        shippingDeadline: "2026-08-30",
        subject: "private subject",
        username: "private_buyer",
      },
      eventType: "shipment_due",
      gmailMessageId: "gmail-1",
      gmailThreadId: "thread-1",
      mailboxAccount: "admin@scgroup1989.com",
      occurredAt: "2026-08-24T03:00:00.000Z",
      orderNumber: databaseOrder.order_number,
    },
  };

  const result = await upsertOrderEvent(parsed, client);

  expect(result.eventCreated).toBe(true);
  expect(client.query).toHaveBeenCalledTimes(2);
  expect(client.query.mock.calls[1][0]).toContain("ON CONFLICT (mailbox_account, gmail_message_id)");
  expect(client.query.mock.calls[1][0]).toContain("DO NOTHING");
  const persistedValues = JSON.stringify(client.query.mock.calls.map((call) => call[1]));
  expect(persistedValues).not.toMatch(/subject|body|buyer|username|phone|address/iu);
  expect(persistedValues).not.toMatch(/recipient|private/iu);
});

test("rejects invalid or mismatched order numbers before persistence", async () => {
  const client = { query: jest.fn() };
  const base = {
    event: { orderNumber: "26082471YK8C02" },
    order: { items: [], orderNumber: "26082471YK8C02" },
  };

  await expect(upsertOrderEvent({
    ...base,
    order: { ...base.order, orderNumber: "SHORT" },
  }, client)).rejects.toThrow("same valid order number");
  await expect(upsertOrderEvent({
    ...base,
    event: { ...base.event, orderNumber: "26082471YK8C03" },
  }, client)).rejects.toThrow("same valid order number");
  expect(client.query).not.toHaveBeenCalled();
});

test("uses a non-blocking mailbox lock and rejects a concurrent sync", async () => {
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
  pool.connect
    .mockResolvedValueOnce(firstClient)
    .mockResolvedValueOnce(secondClient);

  const firstSync = withShopeeOrderSyncLock("Admin@SCGroup1989.com", async () => {
    enterFirstSync();
    return firstCompletion;
  });
  await firstStarted;

  await expect(withShopeeOrderSyncLock("admin@scgroup1989.com", async () => "never"))
    .rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
  expect(secondClient.release).toHaveBeenCalledTimes(1);
  expect(firstClient.release).not.toHaveBeenCalled();

  finishFirstSync("complete");
  await expect(firstSync).resolves.toBe("complete");
  expect(firstClient.release).toHaveBeenCalledTimes(1);
  expect(firstClient.query.mock.calls[0][1]).toEqual([
    "shopee-order-timeline-sync:admin@scgroup1989.com",
  ]);
  expect(firstClient.query.mock.calls[1][0]).toContain("pg_advisory_unlock");
});

test("releases the mailbox lock when the sync callback fails", async () => {
  const callbackFailure = new Error("database write failed");
  const client = {
    query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ unlocked: true }] }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValueOnce(client);

  await expect(withShopeeOrderSyncLock("admin@scgroup1989.com", async () => {
    throw callbackFailure;
  })).rejects.toBe(callbackFailure);

  expect(client.query.mock.calls[1][0]).toContain("pg_advisory_unlock");
  expect(client.release).toHaveBeenCalledTimes(1);
});

test("destroys the session client when advisory unlock fails", async () => {
  const unlockFailure = new Error("connection lost before unlock confirmation");
  const client = {
    query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockRejectedValueOnce(unlockFailure),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValueOnce(client);

  await expect(withShopeeOrderSyncLock("admin@scgroup1989.com", async () => "complete"))
    .rejects.toBe(unlockFailure);
  expect(client.release).toHaveBeenCalledWith(unlockFailure);
});
