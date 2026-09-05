const {
  arrangeManifest,
  inspectOriginal,
  SHOPS,
} = require("../src/modules/seamless/services/accountingOriginalManifest");
const {
  buildAccountingBatchMessage,
  sendAccountingBatchText,
} = require("../src/modules/seamless/services/accountingPrintNotificationService");
const ExcelJS = require("exceljs");
const crypto = require("node:crypto");
function docs() {
  return [
    [
      "orders",
      "2026-07-20",
      "2026-07-26",
      [{ id: "carry", created: "2026-07-25" }],
    ],
    [
      "income",
      "2026-07-27",
      "2026-08-02",
      [
        { id: "carry", created: "2026-07-25" },
        { id: "current", created: "2026-07-27" },
      ],
    ],
    [
      "orders",
      "2026-07-27",
      "2026-08-02",
      [{ id: "current", created: "2026-07-27" }],
    ],
    ["statement", "2026-07-27", "2026-08-02"],
    ["balance", "2026-07-27", "2026-08-02"],
  ].map(([kind, start, end, orders], i) => ({
    shopCode: "sc-drug-store",
    shop: "SC Drug Store",
    kind,
    start,
    end,
    orders,
    filename: i + ".xlsx",
    checksumSha256: crypto.createHash("sha256").update(String(i)).digest("hex"),
  }));
}
test("sorts an unordered upload by shop, financial period and document type, with carry-over before current orders", () => {
  const manifest = arrangeManifest(docs());
  expect(manifest.items.map((item) => item.kind)).toEqual([
    "statement",
    "balance",
    "income",
    "orders",
    "orders",
  ]);
  expect(manifest.items[3].carryOver).toBe(true);
  expect(manifest.shops[0].incomeOrdersCovered).toBe(2);
});
test("reports the exact missing carry-over creation week", () => {
  try {
    arrangeManifest(docs().slice(1));
    throw Error("expected rejection");
  } catch (error) {
    expect(error.statusCode).toBe(400);
    expect(error.details.missingWeeks).toEqual(["2026-07-20"]);
  }
});
test("rejects duplicates, incomplete trios, wrong week boundaries and unused files", () => {
  const source = docs();
  expect(() => arrangeManifest([...source, source[0]])).toThrow(/ซ้ำ/);
  expect(() =>
    arrangeManifest(source.filter((doc) => doc.kind !== "balance")),
  ).toThrow(/Seller Balance/);
  expect(() =>
    arrangeManifest(
      source.map((doc, i) => (i ? doc : { ...doc, end: "2026-07-25" })),
    ),
  ).toThrow(/จันทร์/);
  expect(() =>
    arrangeManifest([
      ...source,
      {
        ...source[0],
        start: "2026-07-13",
        end: "2026-07-19",
        checksumSha256: "unused",
        orders: [],
      },
    ]),
  ).toThrow(/ไม่เกี่ยวข้อง/);
});
test("validates embedded seller ID instead of trusting the upload field", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Income");
  sheet.getCell("B6").value = "หมายเลขคำสั่งซื้อ";
  sheet.getCell("E6").value = "วันที่ทำการสั่งซื้อ";
  sheet.getCell("K6").value = "วันที่โอนชำระเงินสำเร็จ";
  sheet.getCell("A2").value = "wrong-shop";
  await expect(
    inspectOriginal(
      {
        originalname: "Income.โอนเงินสำเร็จ.th.20260727_20260802.xlsx",
        buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      },
      SHOPS[0],
    ),
  ).rejects.toThrow(/ผิดร้าน/);
});
test("LINE message includes an exact ledger link and carries no buyer details", () => {
  const manifest = arrangeManifest(docs());
  const items = manifest.items.map((document) => ({
    document,
    sequence: document.sequence,
    status: "ready",
    page_count: 2,
  }));
  const message = buildAccountingBatchMessage(
    {
      id: "batch-id",
      title: "ทดสอบ",
      printer_name: "Printer",
      agent_host: "000",
      manifest,
    },
    items,
    "started",
    null,
    "https://documents.example",
  );
  expect(message).toMatch(/5 ไฟล์/);
  expect(message).toMatch(/คำสั่งซื้อยกมา 2026-07-20 ถึง 2026-07-26/);
  expect(message).toMatch(/batch=batch-id/);
  expect(message.length).toBeLessThan(4900);
});
describe("LINE HTTP retries", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    process.env.SEAMLESS_LINE_CHANNEL_ACCESS_TOKEN = "test-token";
    process.env.SEAMLESS_LINE_TARGET_ID = "test-group";
  });
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.SEAMLESS_LINE_CHANNEL_ACCESS_TOKEN;
    delete process.env.SEAMLESS_LINE_TARGET_ID;
  });
  test("reuses the persisted retry key and accepts only LINE-confirmed duplicate acceptance", async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 409,
      headers: new Headers({ "x-line-accepted-request-id": "accepted" }),
    }));
    await expect(
      sendAccountingBatchText("ทดสอบ", "retry-uuid"),
    ).resolves.toBeUndefined();
    expect(global.fetch.mock.calls[0][1].headers["X-Line-Retry-Key"]).toBe(
      "retry-uuid",
    );
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 409,
      headers: new Headers(),
    }));
    await expect(
      sendAccountingBatchText("ทดสอบ", "retry-uuid"),
    ).rejects.toThrow(/409/);
  });
});
