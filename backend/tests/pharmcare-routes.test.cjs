process.env.SEAMLESS_DB_SCHEMA = "clasp_scx_seamless";

const express = require("express");
const request = require("supertest");

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

  if (text.startsWith('INSERT INTO "clasp_scx_seamless"."pharmcare_email_messages"')) {
    messageSeq += 1;
    const row = {
      id: `msg-${messageSeq}`,
      mailbox_account: params[0],
      gmail_message_id: params[1],
      route: params[3],
      visible_from: params[4],
      raw_subject: params[7],
      normalized_subject: params[8],
      original_from: params[9],
      original_subject: params[10],
      received_at: params[12],
      status: params[13],
      metadata: JSON.parse(params[17]),
      created_at: new Date(Date.now() + messageSeq).toISOString(),
    };
    state.messages.push(row);
    return { rows: [row], rowCount: 1 };
  }

  if (text.startsWith('INSERT INTO "clasp_scx_seamless"."pharmcare_email_attachments"')) {
    attachmentSeq += 1;
    const row = {
      id: `att-${attachmentSeq}`,
      message_id: params[0],
      original_filename: params[2],
      checksum_sha256: params[5],
      storage_provider: params[6],
      storage_path: params[7],
      status: params[9],
      metadata: JSON.parse(params[10]),
      created_at: new Date(Date.now() + 1000 + attachmentSeq).toISOString(),
    };
    state.attachments.push(row);
    return { rows: [row], rowCount: 1 };
  }

  if (text.startsWith('INSERT INTO "clasp_scx_seamless"."pharmcare_documents"')) {
    documentSeq += 1;
    const row = {
      id: `doc-${documentSeq}`,
      message_id: params[0],
      attachment_id: params[1],
      document_type: params[2],
      document_number: params[3],
      half: params[7],
      review_status: params[9],
      reason_codes: JSON.parse(params[12]),
      metadata: JSON.parse(params[13]),
      created_at: new Date(Date.now() + 2000 + documentSeq).toISOString(),
    };
    state.documents.push(row);
    return { rows: [row], rowCount: 1 };
  }

  if (text.startsWith("SELECT * FROM \"clasp_scx_seamless\".\"pharmcare_email_messages\" WHERE id = $1")) {
    const row = state.messages.find((msg) => msg.id === params[0]);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  if (text.startsWith("SELECT * FROM \"clasp_scx_seamless\".\"pharmcare_email_attachments\" WHERE message_id = $1")) {
    return { rows: state.attachments.filter((att) => att.message_id === params[0]), rowCount: 0 };
  }

  if (
    text.startsWith("SELECT * FROM \"clasp_scx_seamless\".\"pharmcare_documents\" WHERE message_id = $1") &&
    !text.includes("LEFT JOIN")
  ) {
    return { rows: state.documents.filter((doc) => doc.message_id === params[0]), rowCount: 0 };
  }

  if (text.includes('FROM "clasp_scx_seamless"."pharmcare_documents" d') && text.includes("LEFT JOIN")) {
    let rows = state.documents.map((doc) => {
      const message = state.messages.find((msg) => msg.id === doc.message_id);
      const attachment = state.attachments.find((att) => att.id === doc.attachment_id);
      return {
        ...doc,
        attachment_filename: attachment?.original_filename || null,
        gmail_message_id: message?.gmail_message_id,
        message_status: message?.status,
        normalized_subject: message?.normalized_subject,
        original_from: message?.original_from,
        original_subject: message?.original_subject,
        received_at: message?.received_at,
        route: message?.route,
      };
    });

    if (text.includes("d.review_status = $1")) {
      rows = rows.filter((row) => row.review_status === params[0]);
    }
    if (text.includes("d.document_type = $")) {
      const idx = text.includes("d.review_status = $1") ? 1 : 0;
      rows = rows.filter((row) => row.document_type === params[idx]);
    }

    rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const limit = Number(params[params.length - 1]);
    return { rows: rows.slice(0, limit), rowCount: Math.min(rows.length, limit) };
  }

  if (text.startsWith('SELECT * FROM "clasp_scx_seamless"."pharmcare_email_attachments" WHERE id = $1')) {
    const row = state.attachments.find((att) => att.id === params[0]);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  if (text.startsWith("SELECT review_status, COUNT(*)::int AS count")) {
    const counts = {};
    state.documents.forEach((doc) => {
      counts[doc.review_status] = (counts[doc.review_status] || 0) + 1;
    });
    return {
      rows: Object.entries(counts).map(([review_status, count]) => ({ review_status, count })),
      rowCount: 0,
    };
  }

  throw new Error(`Unhandled SQL in pharmcare routes test: ${text}`);
}

jest.mock("../db", () => ({
  query: jest.fn((sql, params) => mockQuery(sql, params)),
}));

jest.mock("../src/modules/seamless/services/fileStorageService", () => ({
  createStoredFileStream: jest.fn(async (storageProvider, storagePath) => {
    if (storagePath === "/missing/path.pdf") {
      throw new Error("ENOENT");
    }
    const { PassThrough } = require("node:stream");
    const stream = new PassThrough();
    stream.end(Buffer.from("%PDF-1.4 fake content"));
    return stream;
  }),
}));

const repository = require("../src/modules/seamless/db/pharmcareRepository");
const { errorHandler } = require("../src/modules/seamless/middleware/errorHandler");

function buildApp() {
  delete require.cache[require.resolve("../src/modules/seamless/middleware/appAuth")];
  delete require.cache[require.resolve("../src/modules/seamless/routes/pharmcareRoutes")];
  // eslint-disable-next-line global-require
  const pharmcareRoutes = require("../src/modules/seamless/routes/pharmcareRoutes");

  const app = express();
  app.use("/api/app/pharmcare", pharmcareRoutes);
  app.use(errorHandler);
  return app;
}

async function seedOneDocument() {
  const message = await repository.createMessage({
    gmailMessageId: "gmail-1",
    mailboxAccount: "admin@scgroup1989.com",
    metadata: {},
    normalizedSubject: "PharmCare e-credit invoice CIV2601000123",
    originalFrom: "info@pharmcare.co",
    originalSubject: "PharmCare e-credit invoice CIV2601000123",
    rawSubject: "PharmCare e-credit invoice CIV2601000123",
    receivedAt: "2026-08-01T03:00:00.000Z",
    route: "gmail_filter_forward",
    status: "classified",
    visibleFrom: "info@pharmcare.co",
  });
  const attachment = await repository.createAttachment({
    checksumSha256: "a".repeat(64),
    gmailAttachmentId: "att-1",
    messageId: message.id,
    metadata: {},
    originalFilename: "CIV2601000123.pdf",
    status: "stored",
    storagePath: "/secret/local/path/CIV2601000123.pdf",
    storageProvider: "local",
  });
  const document = await repository.createDocument({
    attachmentId: attachment.id,
    documentNumber: "CIV2601000123",
    documentType: "e_credit_invoice",
    messageId: message.id,
    metadata: {},
    reasonCodes: ["filename_pattern_match"],
    reviewStatus: "auto_classified",
  });
  return { attachment, document, message };
}

beforeEach(() => {
  resetState();
  delete process.env.SEAMLESS_APP_BASIC_USER;
  delete process.env.SEAMLESS_APP_BASIC_PASSWORD;
});

afterAll(() => {
  delete process.env.SEAMLESS_DB_SCHEMA;
});

describe("PharmCare API routes", () => {
  test("GET /inbox returns documents joined with message fields and a summary", async () => {
    await seedOneDocument();
    const app = buildApp();

    const response = await request(app).get("/api/app/pharmcare/inbox");

    expect(response.status).toBe(200);
    expect(response.body.documents).toHaveLength(1);
    expect(response.body.documents[0]).toMatchObject({
      documentNumber: "CIV2601000123",
      documentType: "e_credit_invoice",
      originalFrom: "info@pharmcare.co",
      route: "gmail_filter_forward",
    });
    expect(response.body.summary).toEqual({ autoClassified: 1, manualReview: 0, duplicate: 0, conflict: 0 });
  });

  test("GET /inbox rejects an invalid documentType filter", async () => {
    const app = buildApp();
    const response = await request(app).get("/api/app/pharmcare/inbox?documentType=not_a_real_type");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  test("GET /messages/:id returns message evidence without leaking storage_path", async () => {
    const { message } = await seedOneDocument();
    const app = buildApp();

    const response = await request(app).get(`/api/app/pharmcare/messages/${message.id}`);

    expect(response.status).toBe(200);
    expect(response.body.attachments).toHaveLength(1);
    expect(response.body.attachments[0].storagePath).toBeUndefined();
    expect(response.body.documents).toHaveLength(1);
  });

  test("GET /messages/:id returns 404 for an unknown id", async () => {
    const app = buildApp();
    const response = await request(app).get("/api/app/pharmcare/messages/does-not-exist");

    expect(response.status).toBe(404);
  });

  test("GET /attachments/:id/download streams the file with correct headers", async () => {
    const { attachment } = await seedOneDocument();
    const app = buildApp();

    const response = await request(app).get(`/api/app/pharmcare/attachments/${attachment.id}/download`);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/application\/pdf|octet-stream/);
    expect(response.headers["content-disposition"]).toContain("CIV2601000123.pdf");
    expect(response.body.toString()).toContain("%PDF");
  });

  test("GET /attachments/:id/download returns 404 for an unknown attachment id", async () => {
    const app = buildApp();
    const response = await request(app).get("/api/app/pharmcare/attachments/does-not-exist/download");

    expect(response.status).toBe(404);
  });

  test("GET /attachments/:id/download returns 404 without leaking the storage path when content is missing", async () => {
    const message = await repository.createMessage({
      gmailMessageId: "gmail-missing",
      mailboxAccount: "admin@scgroup1989.com",
      route: "gmail_filter_forward",
      status: "classified",
    });
    const attachment = await repository.createAttachment({
      gmailAttachmentId: "att-missing",
      messageId: message.id,
      originalFilename: "missing.pdf",
      status: "stored",
      storagePath: "/missing/path.pdf",
      storageProvider: "local",
    });
    const app = buildApp();

    const response = await request(app).get(`/api/app/pharmcare/attachments/${attachment.id}/download`);

    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain("/missing/path.pdf");
  });

  test("routes are rejected without credentials once basic auth is configured", async () => {
    process.env.SEAMLESS_APP_BASIC_USER = "admin";
    process.env.SEAMLESS_APP_BASIC_PASSWORD = "secret";
    const app = buildApp();

    const response = await request(app).get("/api/app/pharmcare/inbox");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  test("routes accept correct basic credentials once configured", async () => {
    process.env.SEAMLESS_APP_BASIC_USER = "admin";
    process.env.SEAMLESS_APP_BASIC_PASSWORD = "secret";
    const app = buildApp();

    const response = await request(app).get("/api/app/pharmcare/inbox").auth("admin", "secret");

    expect(response.status).toBe(200);
  });

  test("GET /inbox strips admin-only fields when authenticated as a regular (non-admin) user", async () => {
    process.env.SEAMLESS_APP_BASIC_USER = "admin";
    process.env.SEAMLESS_APP_BASIC_PASSWORD = "secret";
    await seedOneDocument();
    const app = buildApp();

    const response = await request(app).get("/api/app/pharmcare/inbox").auth("admin", "secret");

    expect(response.status).toBe(200);
    const [document] = response.body.documents;
    expect(document.documentType).toBe("e_credit_invoice");
    expect(document.originalFrom).toBe("info@pharmcare.co");
    expect(document.route).toBeUndefined();
    expect(document.documentNumber).toBeUndefined();
    expect(document.reviewStatus).toBeUndefined();
    expect(document.reasonCodes).toBeUndefined();
  });

  test("GET /inbox keeps admin-only fields when authenticated with the admin credential pair", async () => {
    process.env.SEAMLESS_APP_BASIC_USER = "admin";
    process.env.SEAMLESS_APP_BASIC_PASSWORD = "secret";
    process.env.SEAMLESS_APP_ADMIN_BASIC_USER = "root";
    process.env.SEAMLESS_APP_ADMIN_BASIC_PASSWORD = "root-secret";
    await seedOneDocument();
    const app = buildApp();

    const response = await request(app).get("/api/app/pharmcare/inbox").auth("root", "root-secret");

    expect(response.status).toBe(200);
    const [document] = response.body.documents;
    expect(document.route).toBe("gmail_filter_forward");
    expect(document.documentNumber).toBe("CIV2601000123");
    expect(document.reviewStatus).toBe("auto_classified");
    expect(document.reasonCodes).toEqual(["filename_pattern_match"]);

    delete process.env.SEAMLESS_APP_ADMIN_BASIC_USER;
    delete process.env.SEAMLESS_APP_ADMIN_BASIC_PASSWORD;
  });

  test("GET /messages/:id strips per-document reasonCodes for a regular user but keeps them for admin", async () => {
    process.env.SEAMLESS_APP_BASIC_USER = "admin";
    process.env.SEAMLESS_APP_BASIC_PASSWORD = "secret";
    process.env.SEAMLESS_APP_ADMIN_BASIC_USER = "root";
    process.env.SEAMLESS_APP_ADMIN_BASIC_PASSWORD = "root-secret";
    const { message } = await seedOneDocument();
    const app = buildApp();

    const userResponse = await request(app)
      .get(`/api/app/pharmcare/messages/${message.id}`)
      .auth("admin", "secret");
    expect(userResponse.body.documents[0].reasonCodes).toBeUndefined();

    const adminResponse = await request(app)
      .get(`/api/app/pharmcare/messages/${message.id}`)
      .auth("root", "root-secret");
    expect(adminResponse.body.documents[0].reasonCodes).toEqual(["filename_pattern_match"]);

    delete process.env.SEAMLESS_APP_ADMIN_BASIC_USER;
    delete process.env.SEAMLESS_APP_ADMIN_BASIC_PASSWORD;
  });
});
