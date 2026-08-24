const {
  buildShopeeGmailQuery,
  classifyShopeeSubject,
  extractOrderNumber,
  listShopeeEmailInbox,
} = require("../src/modules/seamless/services/shopeeEmailInboxService");

function rawMessage({
  id,
  subject,
  from = "Shopee <info@mail.shopee.co.th>",
  internalDate = "1787549837000",
  labelIds = [],
}) {
  return {
    id,
    internalDate,
    labelIds,
    payload: {
      headers: [
        { name: "From", value: from },
        { name: "To", value: "admin@scgroup1989.com" },
        { name: "Subject", value: subject },
      ],
    },
    threadId: `thread-${id}`,
  };
}

function gmailError(status) {
  const error = new Error(`Gmail ${status}`);
  error.response = { status };
  return error;
}

describe("Shopee email subject classification", () => {
  test.each([
    ["คำสั่งซื้อชำระเงินปลายทาง #26082476830R2P จากผู้ซื้อ abc ถูกยืนยันแล้ว", "order_confirmed"],
    ["ถึงเวลาจัดส่งสินค้าหมายเลข #26082471YK8C02 แล้ว!", "shipment_due"],
    ["คำสั่งซื้อ #260820SMD6CS64 จากผู้ซื้อ abc ถูกยกเลิก", "order_cancelled"],
    ["สินค้า ABC ของคุณขายหมดแล้ว", "out_of_stock"],
    ["แจ้งเตือนความปลอดภัยของบัญชี: มีการเข้าสู่ระบบด้วยบัญชีของคุณ", "security_alert"],
    ["[แจ้งเตือน] พัสดุกำลังทำการจัดส่งไปยังผู้ขาย กรุณารอการติดต่อจากบริษัทขนส่ง", "seller_return_delivery"],
    ["ประกาศทั่วไปจาก Shopee", "other"],
  ])("classifies %s", (subject, expected) => {
    expect(classifyShopeeSubject(subject)).toBe(expected);
  });

  test("extracts the order number without the leading hash", () => {
    expect(extractOrderNumber("ถึงเวลาจัดส่งสินค้าหมายเลข #26082471YK8C02 แล้ว!")).toBe("26082471YK8C02");
    expect(extractOrderNumber("แจ้งเตือนความปลอดภัย")).toBe("");
  });
});

test("buildShopeeGmailQuery keeps the sender boundary and adds category plus ICT epoch bounds", () => {
  const query = buildShopeeGmailQuery("from:info@mail.shopee.co.th", {
    category: "shipment_due",
    receivedFrom: "2026-08-23T17:00:00.000Z",
    receivedTo: "2026-08-24T17:00:00.000Z",
  });

  expect(query).toContain("from:info@mail.shopee.co.th");
  expect(query).toContain('subject:"ถึงเวลาจัดส่งสินค้า"');
  expect(query).toContain(`after:${Date.parse("2026-08-23T17:00:00.000Z") / 1000 - 1}`);
  expect(query).toContain(`before:${Date.parse("2026-08-24T17:00:00.000Z") / 1000}`);
});

test("listShopeeEmailInbox returns a Gmail page, classifies rows, and excludes a mismatched From header", async () => {
  const messages = new Map([
    [
      "m1",
      rawMessage({
        id: "m1",
        labelIds: ["INBOX", "UNREAD"],
        subject: "คำสั่งซื้อชำระเงินปลายทาง #26082476830R2P จากผู้ซื้อ abc ถูกยืนยันแล้ว",
      }),
    ],
    [
      "m2",
      rawMessage({
        id: "m2",
        from: "Unrelated <other@example.com>",
        subject: "ถึงเวลาจัดส่งสินค้าหมายเลข #SHOULDNOTLEAK แล้ว!",
      }),
    ],
  ]);
  const adapter = {
    listMessagePage: jest.fn(async () => ({ messageIds: ["m1", "m2"], nextPageToken: "next-2" })),
    getMessageMetadata: jest.fn(async (id) => messages.get(id)),
  };

  const result = await listShopeeEmailInbox(
    { cursor: "page-1", limit: 25 },
    { adapter, config: { gmailQuery: "from:info@mail.shopee.co.th" } },
  );

  expect(adapter.listMessagePage).toHaveBeenCalledWith({ maxResults: 25, pageToken: "page-1" });
  expect(result.nextCursor).toBe("next-2");
  expect(result.source).toBe("info@mail.shopee.co.th");
  expect(result.emails).toHaveLength(1);
  expect(result.emails[0]).toMatchObject({
    category: "order_confirmed",
    id: "m1",
    orderNumber: "26082476830R2P",
    unread: true,
  });
  expect(adapter.getMessageMetadata).toHaveBeenCalledTimes(2);
});

test("listShopeeEmailInbox enforces exact inclusive/exclusive date bounds after the broad Gmail query", async () => {
  const receivedFrom = "2026-08-23T17:00:00.000Z";
  const receivedTo = "2026-08-24T17:00:00.000Z";
  const messages = new Map([
    ["before", rawMessage({ id: "before", internalDate: String(Date.parse(receivedFrom) - 1), subject: "ก่อนวัน" })],
    ["start", rawMessage({ id: "start", internalDate: String(Date.parse(receivedFrom)), subject: "เริ่มวัน" })],
    ["inside", rawMessage({ id: "inside", internalDate: String(Date.parse(receivedTo) - 1), subject: "ในวัน" })],
    ["end", rawMessage({ id: "end", internalDate: String(Date.parse(receivedTo)), subject: "วันถัดไป" })],
  ]);
  const adapter = {
    listMessagePage: jest.fn(async () => ({ messageIds: [...messages.keys()], nextPageToken: null })),
    getMessageMetadata: jest.fn(async (id) => messages.get(id)),
  };

  const result = await listShopeeEmailInbox(
    { receivedFrom, receivedTo },
    { adapter, config: { gmailQuery: "from:info@mail.shopee.co.th" } },
  );

  expect(result.emails.map((email) => email.id)).toEqual(["start", "inside"]);
});

test("listShopeeEmailInbox skips a message that disappeared with Gmail 404", async () => {
  const adapter = {
    listMessagePage: jest.fn(async () => ({ messageIds: ["gone"], nextPageToken: "next-page" })),
    getMessageMetadata: jest.fn(async () => { throw gmailError(404); }),
  };

  await expect(listShopeeEmailInbox(
    {},
    { adapter, config: { gmailQuery: "from:info@mail.shopee.co.th" } },
  )).resolves.toEqual({
    emails: [],
    nextCursor: "next-page",
    source: "info@mail.shopee.co.th",
  });
});

test("listShopeeEmailInbox keeps successful rows when another message disappeared with 404", async () => {
  const adapter = {
    listMessagePage: jest.fn(async () => ({ messageIds: ["ok", "gone"], nextPageToken: null })),
    getMessageMetadata: jest.fn(async (id) => {
      if (id === "gone") throw gmailError(404);
      return rawMessage({ id, subject: "ถึงเวลาจัดส่งสินค้าหมายเลข #ORDER1 แล้ว!" });
    }),
  };

  const result = await listShopeeEmailInbox(
    {},
    { adapter, config: { gmailQuery: "from:info@mail.shopee.co.th" } },
  );
  expect(result.emails.map((email) => email.id)).toEqual(["ok"]);
});

test.each([401, 429, 500])("listShopeeEmailInbox rejects a single Gmail %s failure", async (status) => {
  const error = gmailError(status);
  const adapter = {
    listMessagePage: jest.fn(async () => ({ messageIds: ["failed"], nextPageToken: null })),
    getMessageMetadata: jest.fn(async () => { throw error; }),
  };

  await expect(listShopeeEmailInbox(
    {},
    { adapter, config: { gmailQuery: "from:info@mail.shopee.co.th" } },
  )).rejects.toBe(error);
});

test.each([401, 429, 500])("listShopeeEmailInbox rejects mixed success plus Gmail %s instead of returning a partial page", async (status) => {
  const error = gmailError(status);
  const adapter = {
    listMessagePage: jest.fn(async () => ({ messageIds: ["ok", "failed"], nextPageToken: null })),
    getMessageMetadata: jest.fn(async (id) => {
      if (id === "failed") throw error;
      return rawMessage({ id, subject: "ถึงเวลาจัดส่งสินค้าหมายเลข #ORDER1 แล้ว!" });
    }),
  };

  await expect(listShopeeEmailInbox(
    {},
    { adapter, config: { gmailQuery: "from:info@mail.shopee.co.th" } },
  )).rejects.toBe(error);
});

test("listShopeeEmailInbox reuses a successful page for the short cache TTL", async () => {
  const adapter = {
    listMessagePage: jest.fn(async () => ({ messageIds: ["cached"], nextPageToken: null })),
    getMessageMetadata: jest.fn(async () => rawMessage({
      id: "cached",
      subject: "ถึงเวลาจัดส่งสินค้าหมายเลข #CACHE1 แล้ว!",
    })),
  };
  const createAdapter = jest.fn(() => adapter);
  const config = { gmailQuery: "from:info@mail.shopee.co.th label:cache-test" };

  const first = await listShopeeEmailInbox({}, { config, createAdapter });
  const second = await listShopeeEmailInbox({}, { config, createAdapter });

  expect(second).toBe(first);
  expect(createAdapter).toHaveBeenCalledTimes(1);
  expect(adapter.listMessagePage).toHaveBeenCalledTimes(1);
  expect(adapter.getMessageMetadata).toHaveBeenCalledTimes(1);
});
