const {
  createMockGmailAdapter,
  isGmailConfigured,
  normalizeGmailMessage,
} = require("../src/modules/seamless/services/pharmcare/gmailAdapter");

describe("isGmailConfigured", () => {
  test("false when authMode is unset", () => {
    expect(isGmailConfigured({ authMode: "" })).toBe(false);
  });

  test("true for a complete service_account config", () => {
    expect(
      isGmailConfigured({
        authMode: "service_account",
        impersonatedUser: "admin@scgroup1989.com",
        serviceAccountJson: "{}",
      }),
    ).toBe(true);
  });

  test("false for an incomplete oauth_refresh_token config", () => {
    expect(
      isGmailConfigured({
        authMode: "oauth_refresh_token",
        clientId: "id",
        clientSecret: "",
        refreshToken: "token",
      }),
    ).toBe(false);
  });
});

describe("normalizeGmailMessage", () => {
  test("extracts headers, body text, and attachment metadata from a Gmail-API-shaped message", () => {
    const raw = {
      id: "gmail-1",
      internalDate: "1767229200000",
      payload: {
        headers: [
          { name: "From", value: "PharmCare <info@pharmcare.co>" },
          { name: "To", value: "admin@scgroup1989.com" },
          { name: "Subject", value: "PharmCare e-credit invoice CIV2601000123" },
        ],
        parts: [
          {
            body: { data: Buffer.from("hello body").toString("base64") },
            mimeType: "text/plain",
          },
          {
            body: { attachmentId: "att-1", size: 1234 },
            filename: "CIV2601000123.pdf",
            mimeType: "application/pdf",
          },
        ],
      },
      threadId: "thread-1",
    };

    const normalized = normalizeGmailMessage(raw);

    expect(normalized.gmailMessageId).toBe("gmail-1");
    expect(normalized.gmailThreadId).toBe("thread-1");
    expect(normalized.rawSubject).toBe("PharmCare e-credit invoice CIV2601000123");
    expect(normalized.visibleFrom).toBe("PharmCare <info@pharmcare.co>");
    expect(normalized.bodyText).toBe("hello body");
    expect(normalized.attachments).toEqual([
      { attachmentId: "att-1", filename: "CIV2601000123.pdf", mimeType: "application/pdf", sizeBytes: 1234 },
    ]);
  });
});

describe("createMockGmailAdapter", () => {
  test("lists, gets, and returns attachment bytes from an in-memory fixture", async () => {
    const attachmentData = Buffer.from("%PDF-1.4 fixture");
    const adapter = createMockGmailAdapter([
      {
        attachments: [{ attachmentId: "att-1", data: attachmentData }],
        id: "gmail-1",
        payload: { headers: [], parts: [] },
      },
    ]);

    const ids = await adapter.listCandidateMessageIds();
    expect(ids).toEqual(["gmail-1"]);

    const message = await adapter.getMessage("gmail-1");
    expect(message.id).toBe("gmail-1");

    const data = await adapter.getAttachment("gmail-1", "att-1");
    expect(data).toBe(attachmentData);

    await expect(adapter.getMessage("missing")).rejects.toThrow(/not found/);
  });
});
