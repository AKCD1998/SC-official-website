process.env.SEAMLESS_DB_SCHEMA = "clasp_scx_seamless";

const state = { attachments: [], documents: [], messages: [] };

function resetState() {
  state.messages = [];
  state.attachments = [];
  state.documents = [];
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

let messageSeq = 0;
let attachmentSeq = 0;
let documentSeq = 0;

async function mockQuery(sql, params = []) {
  const text = normalizeSql(sql);

  if (text.startsWith('INSERT INTO "clasp_scx_seamless"."pharmcare_email_messages"')) {
    const conflict = state.messages.find(
      (msg) => msg.mailbox_account === params[0] && msg.gmail_message_id === params[1],
    );
    if (conflict) {
      // Emulates ON CONFLICT (mailbox_account, gmail_message_id) DO NOTHING.
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

  if (
    text.startsWith('SELECT * FROM "clasp_scx_seamless"."pharmcare_documents" WHERE attachment_id = $1')
  ) {
    const rows = state.documents
      .filter((doc) => doc.attachment_id === params[0])
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    return { rows, rowCount: rows.length };
  }

  if (text.includes('FROM "clasp_scx_seamless"."pharmcare_documents" d') && text.includes("LEFT JOIN")) {
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

    // listInboxDocuments — apply filters loosely based on the params passed in, in the same
    // order the repository builds them (status, documentType, duplicate has no param, cursor).
    let rows = state.documents.map((doc) => {
      const message = state.messages.find((msg) => msg.id === doc.message_id);
      const attachment = state.attachments.find((att) => att.id === doc.attachment_id);
      return {
        ...doc,
        attachment_filename: attachment?.original_filename || null,
        attachment_checksum_sha256: attachment?.checksum_sha256 || null,
        gmail_message_id: message?.gmail_message_id,
        route: message?.route,
        normalized_subject: message?.normalized_subject,
        original_from: message?.original_from,
        original_subject: message?.original_subject,
        received_at: message?.received_at,
        message_status: message?.status,
      };
    });

    if (text.includes("d.review_status = $1")) {
      rows = rows.filter((row) => row.review_status === params[0]);
    }
    if (text.includes("d.document_type = $")) {
      const idx = text.includes("d.review_status = $1") ? 1 : 0;
      rows = rows.filter((row) => row.document_type === params[idx]);
    }

    rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : -1));

    if (text.includes("(d.created_at, d.id) <")) {
      const cursorCreatedAt = params[params.length - 3];
      const cursorId = params[params.length - 2];
      rows = rows.filter(
        (row) =>
          row.created_at < cursorCreatedAt || (row.created_at === cursorCreatedAt && row.id < cursorId),
      );
    }

    const limit = Number(params[params.length - 1]);
    return { rows: rows.slice(0, limit), rowCount: Math.min(rows.length, limit) };
  }

  if (text.startsWith('SELECT review_status, COUNT(*)::int AS count')) {
    const counts = {};
    state.documents.forEach((doc) => {
      counts[doc.review_status] = (counts[doc.review_status] || 0) + 1;
    });
    const rows = Object.entries(counts).map(([review_status, count]) => ({ review_status, count }));
    return { rows, rowCount: rows.length };
  }

  throw new Error(`Unhandled SQL in pharmcare repository test: ${text}`);
}

jest.mock("../db", () => ({
  query: jest.fn((sql, params) => mockQuery(sql, params)),
}));

const repository = require("../src/modules/seamless/db/pharmcareRepository");

beforeEach(() => {
  resetState();
  messageSeq = 0;
  attachmentSeq = 0;
  documentSeq = 0;
});

afterAll(() => {
  delete process.env.SEAMLESS_DB_SCHEMA;
});

describe("pharmcareRepository", () => {
  test("createMessage then findMessageByGmailId round-trips and maps camelCase fields", async () => {
    const created = await repository.createMessage({
      mailboxAccount: "admin@scgroup1989.com",
      gmailMessageId: "gmail-1",
      route: "gmail_filter_forward",
      visibleFrom: "info@pharmcare.co",
      rawSubject: "PharmCare e-credit invoice CIV2601000123",
      normalizedSubject: "PharmCare e-credit invoice CIV2601000123",
      originalFrom: "info@pharmcare.co",
      originalSubject: "PharmCare e-credit invoice CIV2601000123",
      status: "classified",
      classifierVersion: "pharmcare-classifier-v1",
      metadata: { note: "synthetic" },
    });

    expect(created.id).toBeTruthy();
    expect(created.status).toBe("classified");

    const found = await repository.findMessageByGmailId("admin@scgroup1989.com", "gmail-1");
    expect(found).toMatchObject({ id: created.id, gmailMessageId: "gmail-1" });

    const missing = await repository.findMessageByGmailId("admin@scgroup1989.com", "does-not-exist");
    expect(missing).toBeNull();
  });

  test("createMessage is concurrency-safe: a second insert for the same key returns null instead of a duplicate row", async () => {
    const first = await repository.createMessage({
      mailboxAccount: "admin@scgroup1989.com",
      gmailMessageId: "gmail-race",
      route: "gmail_filter_forward",
      status: "classified",
    });
    expect(first).not.toBeNull();

    const second = await repository.createMessage({
      mailboxAccount: "admin@scgroup1989.com",
      gmailMessageId: "gmail-race",
      route: "gmail_filter_forward",
      status: "classified",
    });

    expect(second).toBeNull();
    expect(state.messages.filter((msg) => msg.gmail_message_id === "gmail-race")).toHaveLength(1);
  });

  test("findCanonicalAttachmentByChecksum returns the earliest stored attachment for a hash", async () => {
    const message = await repository.createMessage({
      mailboxAccount: "admin@scgroup1989.com",
      gmailMessageId: "gmail-2",
      route: "gmail_filter_forward",
      status: "classified",
    });

    const first = await repository.createAttachment({
      messageId: message.id,
      gmailAttachmentId: "att-a",
      originalFilename: "CIV2601000123.pdf",
      checksumSha256: "a".repeat(64),
      status: "stored",
    });

    const canonical = await repository.findCanonicalAttachmentByChecksum("a".repeat(64));
    expect(canonical.id).toBe(first.id);
  });

  test("findDocumentsByDocumentNumber surfaces the linked attachment checksum for conflict detection", async () => {
    const message = await repository.createMessage({
      mailboxAccount: "admin@scgroup1989.com",
      gmailMessageId: "gmail-3",
      route: "gmail_filter_forward",
      status: "classified",
    });
    const attachment = await repository.createAttachment({
      messageId: message.id,
      gmailAttachmentId: "att-b",
      originalFilename: "CIV2601000999.pdf",
      checksumSha256: "b".repeat(64),
      status: "stored",
    });
    await repository.createDocument({
      messageId: message.id,
      attachmentId: attachment.id,
      documentType: "e_credit_invoice",
      documentNumber: "CIV2601000999",
      reviewStatus: "auto_classified",
    });

    const matches = await repository.findDocumentsByDocumentNumber("CIV2601000999");
    expect(matches).toHaveLength(1);
    expect(matches[0].attachmentChecksumSha256).toBe("b".repeat(64));
  });

  test("listInboxDocuments joins message fields and applies documentType/status filters", async () => {
    const message = await repository.createMessage({
      mailboxAccount: "admin@scgroup1989.com",
      gmailMessageId: "gmail-4",
      route: "gmail_filter_forward",
      normalizedSubject: "รายงานสรุปข้อมูลบริการตามรอบ",
      originalFrom: "info@pharmcare.co",
      status: "classified",
    });
    const attachment = await repository.createAttachment({
      messageId: message.id,
      gmailAttachmentId: "att-c",
      originalFilename: "MRR2602-1-HSPCP00533.pdf",
      status: "stored",
    });
    await repository.createDocument({
      messageId: message.id,
      attachmentId: attachment.id,
      documentType: "settlement_mrr",
      reviewStatus: "auto_classified",
      half: "H1",
    });
    await repository.createDocument({
      messageId: message.id,
      documentType: "unknown",
      reviewStatus: "manual_review",
    });

    const { documents } = await repository.listInboxDocuments({});
    expect(documents).toHaveLength(2);
    expect(documents[0].originalFrom).toBe("info@pharmcare.co");
    expect(documents[0].gmailMessageId).toBe("gmail-4");

    const filtered = await repository.listInboxDocuments({ documentType: "settlement_mrr" });
    expect(filtered.documents).toHaveLength(1);
    expect(filtered.documents[0].documentType).toBe("settlement_mrr");
    expect(filtered.documents[0].attachmentFilename).toBe("MRR2602-1-HSPCP00533.pdf");

    const manualReviewOnly = await repository.listInboxDocuments({ status: "manual_review" });
    expect(manualReviewOnly.documents).toHaveLength(1);
    expect(manualReviewOnly.documents[0].reviewStatus).toBe("manual_review");
  });

  test("findDocumentsByAttachmentId returns documents linked to a given canonical attachment", async () => {
    const message = await repository.createMessage({
      mailboxAccount: "admin@scgroup1989.com",
      gmailMessageId: "gmail-attid",
      route: "gmail_filter_forward",
      status: "classified",
    });
    const attachment = await repository.createAttachment({
      messageId: message.id,
      gmailAttachmentId: "att-mrr",
      originalFilename: "MRR2602-1-HSPCP00533.pdf",
      status: "stored",
    });
    const document = await repository.createDocument({
      messageId: message.id,
      attachmentId: attachment.id,
      documentType: "settlement_mrr",
      reviewStatus: "auto_classified",
    });

    const found = await repository.findDocumentsByAttachmentId(attachment.id);
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(document.id);

    expect(await repository.findDocumentsByAttachmentId("no-such-attachment")).toHaveLength(0);
  });

  test("listInboxDocuments cursor pagination: the second page never repeats the first page's rows", async () => {
    const message = await repository.createMessage({
      mailboxAccount: "admin@scgroup1989.com",
      gmailMessageId: "gmail-cursor",
      route: "gmail_filter_forward",
      status: "classified",
    });

    const created = [];
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const document = await repository.createDocument({
        messageId: message.id,
        documentType: "unknown",
        reviewStatus: "manual_review",
      });
      created.push(document.id);
    }

    const firstPage = await repository.listInboxDocuments({ limit: 2 });
    expect(firstPage.documents).toHaveLength(2);
    expect(firstPage.nextCursor).toBeTruthy();
    // Most-recently-created documents come first (ORDER BY created_at DESC).
    expect(firstPage.documents.map((doc) => doc.id)).toEqual([created[4], created[3]]);

    const secondPage = await repository.listInboxDocuments({ cursor: firstPage.nextCursor, limit: 2 });
    expect(secondPage.documents).toHaveLength(2);
    expect(secondPage.documents.map((doc) => doc.id)).toEqual([created[2], created[1]]);

    const firstPageIds = new Set(firstPage.documents.map((doc) => doc.id));
    const overlap = secondPage.documents.filter((doc) => firstPageIds.has(doc.id));
    expect(overlap).toHaveLength(0);

    const thirdPage = await repository.listInboxDocuments({ cursor: secondPage.nextCursor, limit: 2 });
    expect(thirdPage.documents.map((doc) => doc.id)).toEqual([created[0]]);
    expect(thirdPage.nextCursor).toBeNull();
  });

  test("getInboxSummaryCounts groups documents by review_status", async () => {
    const message = await repository.createMessage({
      mailboxAccount: "admin@scgroup1989.com",
      gmailMessageId: "gmail-5",
      route: "gmail_filter_forward",
      status: "classified",
    });
    await repository.createDocument({ messageId: message.id, documentType: "unknown", reviewStatus: "manual_review" });
    await repository.createDocument({ messageId: message.id, documentType: "contract", reviewStatus: "auto_classified" });
    await repository.createDocument({ messageId: message.id, documentType: "contract", reviewStatus: "auto_classified" });

    const counts = await repository.getInboxSummaryCounts();
    expect(counts).toEqual({ autoClassified: 2, manualReview: 1, duplicate: 0, conflict: 0 });
  });
});
