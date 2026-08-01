process.env.SEAMLESS_DB_SCHEMA = "clasp_scx_seamless";

const state = { attachments: [], documents: [], messages: [] };
let messageSeq = 0;
let attachmentSeq = 0;
let documentSeq = 0;

function resetState() {
  state.messages = [];
  state.attachments = [];
  state.documents = [];
  messageSeq = 0;
  attachmentSeq = 0;
  documentSeq = 0;
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

async function mockQuery(sql, params = []) {
  const text = normalizeSql(sql);

  if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
    return { rows: [], rowCount: 0 };
  }

  if (text.startsWith('INSERT INTO "clasp_scx_seamless"."pharmcare_email_messages"')) {
    const conflict = state.messages.find(
      (msg) => msg.mailbox_account === params[0] && msg.gmail_message_id === params[1],
    );
    if (conflict) {
      return { rows: [], rowCount: 0 };
    }

    messageSeq += 1;
    const row = {
      id: `msg-${messageSeq}`,
      mailbox_account: params[0],
      gmail_message_id: params[1],
      gmail_thread_id: params[2],
      route: params[3],
      visible_from: params[4],
      visible_to: params[5],
      visible_cc: params[6],
      raw_subject: params[7],
      normalized_subject: params[8],
      original_from: params[9],
      original_subject: params[10],
      original_date: params[11],
      received_at: params[12],
      status: params[13],
      classifier_version: params[14],
      error_code: params[15],
      error_message: params[16],
      metadata: JSON.parse(params[17]),
      created_at: new Date(Date.now() + messageSeq).toISOString(),
    };
    state.messages.push(row);
    return { rows: [row], rowCount: 1 };
  }

  if (
    text.startsWith(
      'SELECT * FROM "clasp_scx_seamless"."pharmcare_email_messages" WHERE mailbox_account = $1 AND gmail_message_id = $2',
    )
  ) {
    const row = state.messages.find(
      (msg) => msg.mailbox_account === params[0] && msg.gmail_message_id === params[1],
    );
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  if (text.startsWith('INSERT INTO "clasp_scx_seamless"."pharmcare_email_attachments"')) {
    attachmentSeq += 1;
    const row = {
      id: `att-${attachmentSeq}`,
      message_id: params[0],
      gmail_attachment_id: params[1],
      original_filename: params[2],
      mime_type: params[3],
      file_size_bytes: params[4],
      checksum_sha256: params[5],
      storage_provider: params[6],
      storage_path: params[7],
      duplicate_of_attachment_id: params[8],
      status: params[9],
      metadata: JSON.parse(params[10]),
      created_at: new Date(Date.now() + 1000 + attachmentSeq).toISOString(),
    };
    state.attachments.push(row);
    return { rows: [row], rowCount: 1 };
  }

  if (
    text.startsWith(
      'SELECT * FROM "clasp_scx_seamless"."pharmcare_email_attachments" WHERE checksum_sha256 = $1 AND status = \'stored\'',
    )
  ) {
    const rows = state.attachments
      .filter((att) => att.checksum_sha256 === params[0] && att.status === "stored")
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    return { rows: rows.slice(0, 1), rowCount: Math.min(rows.length, 1) };
  }

  if (text.startsWith('INSERT INTO "clasp_scx_seamless"."pharmcare_documents"')) {
    documentSeq += 1;
    const row = {
      id: `doc-${documentSeq}`,
      message_id: params[0],
      attachment_id: params[1],
      document_type: params[2],
      document_number: params[3],
      partner_code: params[4],
      period_start: params[5],
      period_end: params[6],
      half: params[7],
      source_url: params[8],
      review_status: params[9],
      duplicate_of_document_id: params[10],
      classifier_version: params[11],
      reason_codes: JSON.parse(params[12]),
      metadata: JSON.parse(params[13]),
      created_at: new Date(Date.now() + 2000 + documentSeq).toISOString(),
    };
    state.documents.push(row);
    return { rows: [row], rowCount: 1 };
  }

  if (text.startsWith("SELECT d.*, a.checksum_sha256")) {
    const rows = state.documents
      .filter((doc) => doc.document_number === params[0])
      .map((doc) => ({
        ...doc,
        checksum_sha256:
          state.attachments.find((att) => att.id === doc.attachment_id)?.checksum_sha256 || null,
      }));
    return { rows, rowCount: rows.length };
  }

  if (
    text.startsWith('SELECT * FROM "clasp_scx_seamless"."pharmcare_documents" WHERE attachment_id = $1')
  ) {
    const rows = state.documents
      .filter((doc) => doc.attachment_id === params[0])
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    return { rows, rowCount: rows.length };
  }

  throw new Error(`Unhandled SQL in pharmcare sync service test: ${text}`);
}

function makeClient() {
  return {
    query: jest.fn((sql, params) => mockQuery(sql, params)),
    release: jest.fn(),
  };
}

jest.mock("../db", () => ({
  connect: jest.fn(async () => makeClient()),
  query: jest.fn((sql, params) => mockQuery(sql, params)),
}));

const storedFiles = [];
jest.mock("../src/modules/seamless/services/fileStorageService", () => ({
  sha256: (buffer) => require("node:crypto").createHash("sha256").update(buffer).digest("hex"),
  writeStoredFile: jest.fn(async (kind, filename, buffer) => {
    const record = {
      checksumSha256: require("node:crypto").createHash("sha256").update(buffer).digest("hex"),
      fileSizeBytes: buffer.length,
      storagePath: `local://${kind}/${filename}`,
      storageProvider: "local",
    };
    storedFiles.push(record);
    return record;
  }),
}));

const { createMockGmailAdapter } = require("../src/modules/seamless/services/pharmcare/gmailAdapter");
const { syncMessagesFromAdapter } = require("../src/modules/seamless/services/pharmcareSyncService");

function pdfBuffer(content) {
  return Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from(content)]);
}

function base64(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

beforeEach(() => {
  resetState();
  storedFiles.length = 0;
});

afterAll(() => {
  delete process.env.SEAMLESS_DB_SCHEMA;
});

describe("pharmcareSyncService.syncMessagesFromAdapter (mock Gmail adapter -> normalize -> ingest)", () => {
  test("syncs a Gmail-API-shaped message end-to-end: list -> get -> normalize -> fetch attachment -> ingest", async () => {
    const attachmentData = pdfBuffer("CIV2601000123 content");
    const adapter = createMockGmailAdapter([
      {
        attachments: [{ attachmentId: "att-1", data: attachmentData }],
        id: "gmail-sync-1",
        internalDate: "1767229200000",
        payload: {
          headers: [
            { name: "From", value: "PharmCare <info@pharmcare.co>" },
            { name: "Subject", value: "PharmCare e-credit invoice CIV2601000123" },
          ],
          parts: [
            { body: { data: base64("hello") }, mimeType: "text/plain" },
            {
              body: { attachmentId: "att-1", size: attachmentData.length },
              filename: "CIV2601000123.pdf",
              mimeType: "application/pdf",
            },
          ],
        },
        threadId: "thread-1",
      },
    ]);

    const results = await syncMessagesFromAdapter(adapter, "admin@scgroup1989.com");

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("ingested");
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].gmail_message_id).toBe("gmail-sync-1");
    expect(state.messages[0].original_from).toBe("info@pharmcare.co");
    expect(state.documents).toHaveLength(1);
    expect(state.documents[0].document_type).toBe("e_credit_invoice");
    expect(state.documents[0].document_number).toBe("CIV2601000123");
    expect(storedFiles).toHaveLength(1);
  });

  test("running sync twice over the same fixture is idempotent (second pass reports already_ingested)", async () => {
    const attachmentData = pdfBuffer("CIV2601000456 content");
    const fixture = [
      {
        attachments: [{ attachmentId: "att-1", data: attachmentData }],
        id: "gmail-sync-2",
        payload: {
          headers: [
            { name: "From", value: "PharmCare <info@pharmcare.co>" },
            { name: "Subject", value: "PharmCare e-credit invoice CIV2601000456" },
          ],
          parts: [
            {
              body: { attachmentId: "att-1", size: attachmentData.length },
              filename: "CIV2601000456.pdf",
              mimeType: "application/pdf",
            },
          ],
        },
      },
    ];

    const firstAdapter = createMockGmailAdapter(fixture);
    const first = await syncMessagesFromAdapter(firstAdapter, "admin@scgroup1989.com");
    expect(first[0].status).toBe("ingested");

    const secondAdapter = createMockGmailAdapter(fixture);
    const second = await syncMessagesFromAdapter(secondAdapter, "admin@scgroup1989.com");
    expect(second[0].status).toBe("already_ingested");

    expect(state.messages).toHaveLength(1);
    expect(state.documents).toHaveLength(1);
  });

  test("one message failing does not stop the rest of the batch from being ingested", async () => {
    const goodAttachment = pdfBuffer("CIV2601000789 content");
    const adapter = createMockGmailAdapter([
      {
        id: "gmail-sync-missing-attachment",
        payload: {
          headers: [{ name: "From", value: "PharmCare <info@pharmcare.co>" }],
          parts: [
            {
              body: { attachmentId: "att-does-not-exist-in-fixture", size: 10 },
              filename: "CIV0000000000.pdf",
              mimeType: "application/pdf",
            },
          ],
        },
      },
      {
        attachments: [{ attachmentId: "att-1", data: goodAttachment }],
        id: "gmail-sync-3",
        payload: {
          headers: [
            { name: "From", value: "PharmCare <info@pharmcare.co>" },
            { name: "Subject", value: "PharmCare e-credit invoice CIV2601000789" },
          ],
          parts: [
            {
              body: { attachmentId: "att-1", size: goodAttachment.length },
              filename: "CIV2601000789.pdf",
              mimeType: "application/pdf",
            },
          ],
        },
      },
    ]);

    const results = await syncMessagesFromAdapter(adapter, "admin@scgroup1989.com");

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("failed");
    expect(results[0].gmailMessageId).toBe("gmail-sync-missing-attachment");
    expect(results[1].status).toBe("ingested");
    expect(results[1].gmailMessageId).toBe("gmail-sync-3");

    // Only the successful message's row should exist — the failed one wrote nothing.
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].gmail_message_id).toBe("gmail-sync-3");
  });
});
