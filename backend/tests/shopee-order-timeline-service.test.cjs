const {
  syncShopeeOrderPage,
} = require("../src/modules/seamless/services/shopeeOrderTimelineService");

function encode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function rawMessage({ id, subject, body, from = "Shopee <info@mail.shopee.co.th>" }) {
  return {
    id,
    internalDate: "1787549837000",
    payload: {
      headers: [
        { name: "From", value: from },
        { name: "Subject", value: subject },
      ],
      parts: [{ body: { data: encode(body) }, mimeType: "text/html" }],
    },
    threadId: `thread-${id}`,
  };
}

function repositoryWithSyncLock(overrides = {}) {
  return {
    withShopeeOrderSyncLock: jest.fn(async (_mailboxAccount, callback) => callback()),
    ...overrides,
  };
}

test("syncs one bounded Gmail page, skips non-order mail, and reports deduplication", async () => {
  const messages = new Map([
    ["new", rawMessage({
      id: "new",
      subject: "คำสั่งซื้อชำระเงินปลายทาง #26082476830R2P จากผู้ซื้อ buyer ถูกยืนยันแล้ว",
      body: "<div>หมายเลขคำสั่งซื้อ:</div><div>#26082476830R2P</div>",
    })],
    ["duplicate", rawMessage({
      id: "duplicate",
      subject: "ถึงเวลาจัดส่งสินค้าหมายเลข #26082476830R2P แล้ว!",
      body: "<div>หมายเลขคำสั่งซื้อ:</div><div>#26082476830R2P</div>",
    })],
    ["security", rawMessage({
      id: "security",
      subject: "แจ้งเตือนความปลอดภัยของบัญชี",
      body: "<div>ไม่มีคำสั่งซื้อ</div>",
    })],
    ["wrong-sender", rawMessage({
      id: "wrong-sender",
      from: "Other <other@example.com>",
      subject: "ถึงเวลาจัดส่งสินค้าหมายเลข #26082476830R2P แล้ว!",
      body: "<div>หมายเลขคำสั่งซื้อ:</div><div>#26082476830R2P</div>",
    })],
  ]);
  const adapter = {
    getMessage: jest.fn(async (id) => messages.get(id)),
    listMessagePage: jest.fn(async () => ({
      messageIds: [...messages.keys()],
      nextPageToken: "older-page",
    })),
  };
  const repository = repositoryWithSyncLock({
    upsertOrderEvent: jest.fn(async (parsed) => ({
      eventCreated: parsed.event.gmailMessageId === "new",
    })),
  });

  const result = await syncShopeeOrderPage(
    { cursor: "page-1", limit: 4 },
    { adapter, config: { gmailQuery: "from:info@mail.shopee.co.th", mailboxAccount: "admin@scgroup1989.com" }, repository },
  );

  expect(adapter.listMessagePage).toHaveBeenCalledWith({ maxResults: 4, pageToken: "page-1" });
  expect(repository.withShopeeOrderSyncLock).toHaveBeenCalledWith(
    "admin@scgroup1989.com",
    expect.any(Function),
  );
  expect(repository.withShopeeOrderSyncLock.mock.invocationCallOrder[0])
    .toBeLessThan(adapter.listMessagePage.mock.invocationCallOrder[0]);
  expect(repository.upsertOrderEvent).toHaveBeenCalledTimes(2);
  expect(result).toEqual({
    deduplicatedEvents: 1,
    nextCursor: "older-page",
    processedMessages: 4,
    skippedMessages: 2,
    source: "info@mail.shopee.co.th",
    storedEvents: 1,
  });
  expect(JSON.stringify(repository.upsertOrderEvent.mock.calls)).not.toContain("buyer");
});

test("skips a Gmail 404 but rejects quota/auth/upstream failures", async () => {
  const missing = new Error("gone");
  missing.response = { status: 404 };
  const adapter404 = {
    getMessage: jest.fn(async () => { throw missing; }),
    listMessagePage: jest.fn(async () => ({ messageIds: ["gone"], nextPageToken: null })),
  };
  await expect(syncShopeeOrderPage({}, {
    adapter: adapter404,
    config: { mailboxAccount: "admin@scgroup1989.com" },
    repository: repositoryWithSyncLock({ upsertOrderEvent: jest.fn() }),
  })).resolves.toMatchObject({ processedMessages: 0, skippedMessages: 1 });

  const quota = new Error("quota");
  quota.response = { status: 429 };
  const adapter429 = {
    getMessage: jest.fn(async () => { throw quota; }),
    listMessagePage: jest.fn(async () => ({ messageIds: ["limited"], nextPageToken: null })),
  };
  await expect(syncShopeeOrderPage({}, {
    adapter: adapter429,
    config: { mailboxAccount: "admin@scgroup1989.com" },
    repository: repositoryWithSyncLock({ upsertOrderEvent: jest.fn() }),
  })).rejects.toBe(quota);
});

test("prefers the bounded full-message adapter operation for interactive sync", async () => {
  const adapter = {
    getMessage: jest.fn(async () => { throw new Error("unbounded path must not be used"); }),
    getMessageBounded: jest.fn(async () => rawMessage({
      id: "bounded",
      subject: "ถึงเวลาจัดส่งสินค้าหมายเลข #26082476830R2P แล้ว!",
      body: "<div>หมายเลขคำสั่งซื้อ:</div><div>#26082476830R2P</div>",
    })),
    listMessagePage: jest.fn(async () => ({ messageIds: ["bounded"], nextPageToken: null })),
  };
  const result = await syncShopeeOrderPage({}, {
    adapter,
    config: { mailboxAccount: "admin@scgroup1989.com" },
    repository: repositoryWithSyncLock({
      upsertOrderEvent: jest.fn(async () => ({ eventCreated: true })),
    }),
  });

  expect(adapter.getMessageBounded).toHaveBeenCalledWith("bounded");
  expect(adapter.getMessage).not.toHaveBeenCalled();
  expect(result.storedEvents).toBe(1);
});

test("does not call Gmail when the cross-request mailbox lock is busy", async () => {
  const busy = new Error("sync already running");
  busy.statusCode = 409;
  const adapter = {
    getMessage: jest.fn(),
    listMessagePage: jest.fn(),
  };
  const repository = repositoryWithSyncLock({
    upsertOrderEvent: jest.fn(),
    withShopeeOrderSyncLock: jest.fn(async () => { throw busy; }),
  });

  await expect(syncShopeeOrderPage({}, {
    adapter,
    config: { mailboxAccount: "admin@scgroup1989.com" },
    repository,
  })).rejects.toBe(busy);

  expect(adapter.listMessagePage).not.toHaveBeenCalled();
  expect(adapter.getMessage).not.toHaveBeenCalled();
  expect(repository.upsertOrderEvent).not.toHaveBeenCalled();
});
