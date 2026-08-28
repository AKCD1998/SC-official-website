const {
  createGmailAdapter,
  createMockGmailAdapter,
  isGmailConfigured,
  normalizeGmailMessage,
} = require("../src/modules/seamless/services/pharmcare/gmailAdapter");

const SERVICE_ACCOUNT_CONFIG = {
  authMode: "service_account",
  gmailQuery: "from:info@pharmcare.co OR from:auukunn.bkk@gmail.com",
  impersonatedUser: "admin@scgroup1989.com",
  serviceAccountJson: JSON.stringify({ client_email: "sa@test.iam.gserviceaccount.com" }),
};

// Fake googleapis gmail client: records the calls it receives so tests can assert the adapter
// only ever issues the three read operations, with the right parameters.
function makeFakeGmailClient({
  messages = [],
  attachments = {},
  nextPageToken = null,
  profileEmail = "admin@scgroup1989.com",
} = {}) {
  const calls = [];
  return {
    calls,
    users: {
      getProfile: async (params) => {
        calls.push({ method: "getProfile", params });
        return { data: { emailAddress: profileEmail } };
      },
      messages: {
        list: async (params, options) => {
          calls.push({ method: "list", options, params });
          const matching = messages.filter((m) => !params.q || !params.q.includes("after:") || Number(m.internalDate) / 1000 > Number((params.q.match(/after:(\d+)/) || [])[1]));
          const pageSize = params.maxResults || 100;
          const page = matching.slice(0, pageSize);
          return { data: { messages: page.map((m) => ({ id: m.id })), nextPageToken } };
        },
        get: async (params, options) => {
          calls.push({ method: "get", options, params });
          const message = messages.find((m) => m.id === params.id);
          if (!message) {
            throw new Error("message not found");
          }
          return { data: message };
        },
        attachments: {
          get: async (params) => {
            calls.push({ method: "attachments.get", params });
            const data = attachments[`${params.messageId}/${params.id}`];
            if (!data) {
              throw new Error("attachment not found");
            }
            return { data: { data } };
          },
        },
      },
      watch: async (params) => {
        calls.push({ method: "watch", params });
        return { data: { expiration: "1767315600000", historyId: "hist-123" } };
      },
    },
  };
}

function b64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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

  // Regression test for a real live parsing failure (2026-08-19): a genuine PharmCare monthly
  // report forward had text/plain nested inside a multipart/alternative part, sitting alongside
  // sibling attachment parts at the top level — parts: [multipart/alternative,
  // application/octet-stream, application/octet-stream]. bodyText came back empty, so the
  // forwarded-block parser couldn't find the original sender even though the message genuinely
  // was PharmCare.
  test("finds text/plain nested inside a multipart/alternative part, not just top-level parts", () => {
    const raw = {
      id: "gmail-nested",
      payload: {
        headers: [
          { name: "From", value: "Someone <auukunn.bkk@gmail.com>" },
          { name: "Subject", value: "Fwd: PharmCare- รายงานสรุปข้อมูลบริการประจําเดือน" },
        ],
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              {
                body: { data: Buffer.from("---------- Forwarded message ---------\nFrom: PharmCare <info@pharmcare.co>\nSubject: PharmCare- รายงานสรุปข้อมูลบริการประจําเดือน\n").toString("base64") },
                mimeType: "text/plain",
              },
              {
                body: { data: Buffer.from("<p>html version</p>").toString("base64") },
                mimeType: "text/html",
              },
            ],
          },
          {
            body: { attachmentId: "att-1", size: 999 },
            filename: "report.pdf",
            mimeType: "application/octet-stream",
          },
          {
            body: { attachmentId: "att-2", size: 111 },
            filename: "report2.pdf",
            mimeType: "application/octet-stream",
          },
        ],
      },
    };

    const normalized = normalizeGmailMessage(raw);

    expect(normalized.bodyText).toContain("From: PharmCare <info@pharmcare.co>");
    expect(normalized.attachments).toHaveLength(2);
    expect(normalized.attachments.map((a) => a.attachmentId)).toEqual(["att-1", "att-2"]);
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

describe("createGmailAdapter (real, googleapis-backed with injected fake client)", () => {
  test("verifies an expected mailbox exactly before the first Gmail message operation", async () => {
    const fake = makeFakeGmailClient({
      messages: [{ id: "m1", payload: { headers: [], parts: [] } }],
      profileEmail: "scgroup1989.glucooneshop@gmail.com",
    });
    const adapter = createGmailAdapter({
      authMode: "oauth_refresh_token",
      clientId: "client-id-placeholder",
      clientSecret: "client-secret-placeholder",
      expectedMailbox: "scgroup1989.glucooneshop@gmail.com",
      gmailQuery: "from:info@mail.shopee.co.th",
      refreshToken: "refresh-token-placeholder",
    }, { createGmailClient: () => fake });

    await adapter.listMessagePage({ maxResults: 1 });
    await adapter.getMessageMetadata("m1");

    expect(fake.calls.map((call) => call.method)).toEqual(["getProfile", "list", "get"]);
    expect(fake.calls[0].params).toEqual({ userId: "me" });
    ["send", "forward", "delete", "archive", "markRead", "modifyLabels"].forEach((operation) => {
      expect(adapter[operation]).toBeUndefined();
    });
  });

  test("fails closed before listing messages when the OAuth account is not the exact mailbox", async () => {
    const fake = makeFakeGmailClient({
      profileEmail: "SCGROUP1989.GLUCOONESHOP@gmail.com",
    });
    const adapter = createGmailAdapter({
      authMode: "oauth_refresh_token",
      clientId: "client-id-placeholder",
      clientSecret: "client-secret-placeholder",
      expectedMailbox: "scgroup1989.glucooneshop@gmail.com",
      gmailQuery: "from:info@mail.shopee.co.th",
      refreshToken: "refresh-token-placeholder",
    }, { createGmailClient: () => fake });

    await expect(adapter.listMessagePage()).rejects.toThrow(/identity check failed/);
    expect(fake.calls.map((call) => call.method)).toEqual(["getProfile"]);
  });

  test("lists candidate message ids using the configured query and after: filter", async () => {
    const fake = makeFakeGmailClient({
      messages: [{ id: "m1", internalDate: "1767229200000" }],
    });
    const adapter = createGmailAdapter(SERVICE_ACCOUNT_CONFIG, { createGmailClient: () => fake });

    const ids = await adapter.listCandidateMessageIds({ after: "2026-01-01T00:00:00Z" });

    expect(ids).toEqual(["m1"]);
    const listCall = fake.calls.find((c) => c.method === "list");
    expect(listCall.params.userId).toBe("me");
    expect(listCall.params.q).toContain("from:info@pharmcare.co");
    expect(listCall.params.q).toMatch(/after:\d+/);
  });

  test("getMessage and getAttachment issue only read calls and decode base64url attachment data", async () => {
    const pdfBytes = Buffer.from("%PDF-1.4 test bytes");
    const fake = makeFakeGmailClient({
      attachments: { "m1/att-1": b64url(pdfBytes) },
      messages: [{ id: "m1", payload: { headers: [], parts: [] } }],
    });
    const adapter = createGmailAdapter(SERVICE_ACCOUNT_CONFIG, { createGmailClient: () => fake });

    const message = await adapter.getMessage("m1");
    expect(message.id).toBe("m1");

    const attachment = await adapter.getAttachment("m1", "att-1");
    expect(attachment.equals(pdfBytes)).toBe(true);

    const methods = fake.calls.map((c) => c.method).sort();
    // Only read operations were issued for get+attachment — no send/modify/label/delete path.
    expect(methods).toEqual(["attachments.get", "get"].sort());
  });

  test("listMessagePage preserves Gmail pagination tokens for an app-driven inbox", async () => {
    const fake = makeFakeGmailClient({
      messages: [{ id: "m1" }, { id: "m2" }],
      nextPageToken: "gmail-page-2",
    });
    const adapter = createGmailAdapter(SERVICE_ACCOUNT_CONFIG, { createGmailClient: () => fake });

    const page = await adapter.listMessagePage({ maxResults: 2, pageToken: "gmail-page-1" });

    expect(page).toEqual({ messageIds: ["m1", "m2"], nextPageToken: "gmail-page-2" });
    const listCall = fake.calls.find((call) => call.method === "list");
    expect(listCall.params.pageToken).toBe("gmail-page-1");
    expect(listCall.params.maxResults).toBe(2);
    expect(listCall.options.retry).toBe(false);
    expect(listCall.options.timeout).toBe(10000);
  });

  test("getMessageMetadata fetches only the Shopee inbox envelope fields with a timeout", async () => {
    const fake = makeFakeGmailClient({
      messages: [{ id: "m1", internalDate: "1787549837000", payload: { headers: [] } }],
    });
    const adapter = createGmailAdapter(SERVICE_ACCOUNT_CONFIG, { createGmailClient: () => fake });

    const message = await adapter.getMessageMetadata("m1");

    expect(message.id).toBe("m1");
    const getCall = fake.calls.find((call) => call.method === "get");
    expect(getCall.params).toMatchObject({
      fields: "id,threadId,internalDate,labelIds,payload(headers)",
      format: "metadata",
      id: "m1",
      metadataHeaders: ["From", "Subject", "To"],
      userId: "me",
    });
    expect(getCall.options.retry).toBe(false);
    expect(getCall.options.timeout).toBe(10000);
  });

  test("getMessageRoutingMetadata requests From/To only and never requests Subject or body", async () => {
    const fake = makeFakeGmailClient({
      messages: [{ id: "m1", internalDate: "1787549837000", payload: { headers: [] } }],
    });
    const adapter = createGmailAdapter(SERVICE_ACCOUNT_CONFIG, { createGmailClient: () => fake });

    await adapter.getMessageRoutingMetadata("m1");

    const getCall = fake.calls.find((call) => call.method === "get");
    expect(getCall.params).toMatchObject({
      fields: "id,internalDate,payload(headers)",
      format: "metadata",
      id: "m1",
      metadataHeaders: ["From", "To"],
      userId: "me",
    });
    expect(JSON.stringify(getCall.params)).not.toMatch(/Subject|body/iu);
  });

  test("getMessageBounded fetches full MIME content without retry and with a timeout", async () => {
    const fake = makeFakeGmailClient({
      messages: [{ id: "m1", internalDate: "1787549837000", payload: { headers: [] } }],
    });
    const adapter = createGmailAdapter(SERVICE_ACCOUNT_CONFIG, { createGmailClient: () => fake });

    const message = await adapter.getMessageBounded("m1");

    expect(message.id).toBe("m1");
    const getCall = fake.calls.find((call) => call.method === "get");
    expect(getCall.params).toMatchObject({ format: "full", id: "m1", userId: "me" });
    expect(getCall.options.retry).toBe(false);
    expect(getCall.options.timeout).toBe(10000);
  });

  test("rejects with a 503-style error when credentials are not configured", async () => {
    const adapter = createGmailAdapter({ authMode: "" }, { createGmailClient: () => makeFakeGmailClient() });
    await expect(adapter.listCandidateMessageIds()).rejects.toThrow(/not configured/);
    await expect(adapter.getMessage("m1")).rejects.toThrow(/not configured/);
    await expect(adapter.getMessageBounded("m1")).rejects.toThrow(/not configured/);
    await expect(adapter.getMessageMetadata("m1")).rejects.toThrow(/not configured/);
    await expect(adapter.getAttachment("m1", "a1")).rejects.toThrow(/not configured/);
  });

  test("watchMailbox subscribes the mailbox to the given Pub/Sub topic and returns expiry info", async () => {
    const fake = makeFakeGmailClient();
    const adapter = createGmailAdapter(SERVICE_ACCOUNT_CONFIG, { createGmailClient: () => fake });

    const result = await adapter.watchMailbox("projects/my-project/topics/pharmcare-gmail-notifications");

    expect(result).toEqual({ expiration: "1767315600000", historyId: "hist-123" });
    const watchCall = fake.calls.find((c) => c.method === "watch");
    expect(watchCall.params.userId).toBe("me");
    expect(watchCall.params.requestBody).toEqual({
      labelIds: ["INBOX"],
      topicName: "projects/my-project/topics/pharmcare-gmail-notifications",
    });
  });

  test("watchMailbox rejects when credentials are not configured", async () => {
    const adapter = createGmailAdapter({ authMode: "" }, { createGmailClient: () => makeFakeGmailClient() });
    await expect(adapter.watchMailbox("projects/x/topics/y")).rejects.toThrow(/not configured/);
  });
});
