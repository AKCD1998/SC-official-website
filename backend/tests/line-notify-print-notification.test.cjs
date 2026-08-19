const { sendPrintNotification } = require("../src/modules/seamless/services/lineNotifyService");

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.SEAMLESS_LINE_CHANNEL_ACCESS_TOKEN;
  delete process.env.SEAMLESS_LINE_TARGET_ID;
});

function configureLine() {
  process.env.SEAMLESS_LINE_CHANNEL_ACCESS_TOKEN = "test-token";
  process.env.SEAMLESS_LINE_TARGET_ID = "test-target";
}

const baseJob = {
  completedAt: "2026-08-19T10:00:00.000Z",
  printerName: "HP LaserJet",
  agentHost: "HQ000",
  isReprint: false,
  attemptNo: 1,
};

describe("lineNotifyService.sendPrintNotification — Seamless vs PharmCare templates", () => {
  test("a regular (non-PharmCare) record gets the green Seamless bubble", async () => {
    configureLine();
    const fetchSpy = jest.fn(async () => ({ ok: true }));
    global.fetch = fetchSpy;

    await sendPrintNotification(baseJob, {
      filename: "20260819_001.xlsx",
      reportDate: "20260819",
      branchCodes: "001",
      metadata: {},
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const bubble = body.messages[0].contents;
    expect(body.messages[0].altText).toMatch(/^📄/);
    expect(bubble.header.backgroundColor).toBe("#0D7A56");
    expect(JSON.stringify(bubble.body)).toMatch(/ปริ้นเอกสารส่งพี่เอแล้ว/);
    expect(JSON.stringify(bubble.body)).not.toMatch(/PharmCare/);
  });

  test("a PharmCare-sourced record (metadata.source === 'pharmcare') gets the teal PharmCare bubble", async () => {
    configureLine();
    const fetchSpy = jest.fn(async () => ({ ok: true }));
    global.fetch = fetchSpy;

    await sendPrintNotification(baseJob, {
      filename: "CIV2601000123.pdf",
      metadata: {
        source: "pharmcare",
        pharmcareDocumentType: "e_credit_invoice",
        pharmcareDocumentNumber: "CIV2601000123",
      },
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const bubble = body.messages[0].contents;
    expect(body.messages[0].altText).toMatch(/^💊/);
    expect(bubble.header.backgroundColor).toBe("#1DADA8");
    const bodyText = JSON.stringify(bubble.body);
    expect(bodyText).toMatch(/PharmCare/);
    expect(bodyText).toMatch(/E-Credit Invoice/);
    expect(bodyText).toMatch(/CIV2601000123/);
  });

  test("an unrecognized PharmCare document type falls back to the raw type string, not a crash", async () => {
    configureLine();
    const fetchSpy = jest.fn(async () => ({ ok: true }));
    global.fetch = fetchSpy;

    await sendPrintNotification(baseJob, {
      filename: "future-type.pdf",
      metadata: { source: "pharmcare", pharmcareDocumentType: "some_future_type" },
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(JSON.stringify(body.messages[0].contents.body)).toMatch(/some_future_type/);
  });

  test("a reprint still shows the reprint warning box on the PharmCare template", async () => {
    configureLine();
    const fetchSpy = jest.fn(async () => ({ ok: true }));
    global.fetch = fetchSpy;

    await sendPrintNotification(
      { ...baseJob, isReprint: true, attemptNo: 2, reprintReason: "hardware jam" },
      { filename: "CIV2601000123.pdf", metadata: { source: "pharmcare" } },
    );

    const bodyText = JSON.stringify(JSON.parse(fetchSpy.mock.calls[0][1].body).messages[0].contents.body);
    expect(bodyText).toMatch(/ปริ้นซ้ำครั้งที่ 2/);
    expect(bodyText).toMatch(/hardware jam/);
  });
});
