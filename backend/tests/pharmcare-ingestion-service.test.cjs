process.env.SEAMLESS_DB_SCHEMA = "clasp_scx_seamless";

const crypto = require("node:crypto");

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

  throw new Error(`Unhandled SQL in pharmcare ingestion test: ${text}`);
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
  sha256: jest.requireActual("node:crypto")
    ? (buffer) => require("node:crypto").createHash("sha256").update(buffer).digest("hex")
    : null,
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

const { ingestNormalizedMessage } = require("../src/modules/seamless/services/pharmcareIngestionService");

function pdfBuffer(content) {
  return Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from(content)]);
}

beforeEach(() => {
  resetState();
  storedFiles.length = 0;
  jest.clearAllMocks();
});

afterAll(() => {
  delete process.env.SEAMLESS_DB_SCHEMA;
});

describe("pharmcareIngestionService.ingestNormalizedMessage", () => {
  const baseDto = {
    attachments: [
      {
        attachmentId: "gmail-att-1",
        buffer: pdfBuffer("CIV2601000123 content"),
        filename: "CIV2601000123.pdf",
        mimeType: "application/pdf",
      },
    ],
    gmailMessageId: "gmail-msg-1",
    gmailThreadId: "thread-1",
    mailboxAccount: "admin@scgroup1989.com",
    rawSubject: "PharmCare e-credit invoice CIV2601000123",
    receivedAt: "2026-08-01T03:00:00.000Z",
    visibleFrom: "PharmCare <info@pharmcare.co>",
  };

  test("ingests a new message: stores the attachment, classifies, and persists documents", async () => {
    const result = await ingestNormalizedMessage(baseDto);

    expect(result.status).toBe("ingested");
    expect(state.messages).toHaveLength(1);
    expect(state.attachments).toHaveLength(1);
    expect(state.documents).toHaveLength(1);
    expect(state.documents[0].document_type).toBe("e_credit_invoice");
    expect(state.documents[0].review_status).toBe("auto_classified");
    expect(storedFiles).toHaveLength(1);
  });

  test("re-ingesting the same gmailMessageId is idempotent and creates no new rows", async () => {
    await ingestNormalizedMessage(baseDto);
    const second = await ingestNormalizedMessage(baseDto);

    expect(second.status).toBe("already_ingested");
    expect(state.messages).toHaveLength(1);
    expect(state.attachments).toHaveLength(1);
    expect(state.documents).toHaveLength(1);
    expect(storedFiles).toHaveLength(1);
  });

  test("an identical attachment arriving on a second message is stored once and linked as duplicate", async () => {
    await ingestNormalizedMessage(baseDto);

    const secondDto = {
      ...baseDto,
      gmailMessageId: "gmail-msg-2",
      rawSubject: "Fwd: PharmCare e-credit invoice CIV2601000123",
      visibleFrom: "auukunn.bkk@gmail.com",
      bodyText: [
        "---------- Forwarded message ---------",
        "From: PharmCare <info@pharmcare.co>",
        "Date: Mon, Jan 5, 2026 at 9:00 AM",
        "Subject: PharmCare e-credit invoice CIV2601000123",
        "To: <auukunn.bkk@gmail.com>",
        "",
        "body",
      ].join("\n"),
    };

    const result = await ingestNormalizedMessage(secondDto);

    expect(result.status).toBe("ingested");
    expect(state.attachments).toHaveLength(2);
    expect(state.attachments[1].status).toBe("duplicate");
    expect(state.attachments[1].duplicate_of_attachment_id).toBe(state.attachments[0].id);
    // The file bytes are only actually written to storage once — the duplicate reuses the path.
    expect(storedFiles).toHaveLength(1);
    expect(state.documents[1].review_status).toBe("duplicate");
    expect(state.documents[1].duplicate_of_document_id).toBe(state.documents[0].id);
  });

  test("same CIV document number with different content is flagged conflict, not overwritten", async () => {
    await ingestNormalizedMessage(baseDto);

    const conflictingDto = {
      ...baseDto,
      attachments: [
        {
          attachmentId: "gmail-att-2",
          buffer: pdfBuffer("DIFFERENT CIV2601000123 content"),
          filename: "CIV2601000123.pdf",
          mimeType: "application/pdf",
        },
      ],
      gmailMessageId: "gmail-msg-3",
    };

    const result = await ingestNormalizedMessage(conflictingDto);

    expect(result.status).toBe("ingested");
    expect(state.documents[1].review_status).toBe("conflict");
    expect(JSON.parse(JSON.stringify(state.documents[1].reason_codes))).toContain(
      "document_number_conflict",
    );
  });

  test("an attachment failing the PDF signature check is stored as failed and sent to manual review", async () => {
    const dto = {
      ...baseDto,
      attachments: [
        {
          attachmentId: "gmail-att-not-pdf",
          buffer: Buffer.from("not a pdf"),
          filename: "CIV2601000555.pdf",
          mimeType: "application/pdf",
        },
      ],
      gmailMessageId: "gmail-msg-4",
    };

    const result = await ingestNormalizedMessage(dto);

    expect(result.status).toBe("ingested");
    expect(state.attachments[0].status).toBe("failed");
    expect(state.documents[0].review_status).toBe("manual_review");
    expect(storedFiles).toHaveLength(0);
  });

  test("a sender outside the allowlist still ingests but every document is manual_review", async () => {
    const dto = {
      ...baseDto,
      gmailMessageId: "gmail-msg-5",
      visibleFrom: "someone-else@example.com",
    };

    const result = await ingestNormalizedMessage(dto);

    expect(result.status).toBe("ingested");
    expect(state.messages[0].status).toBe("manual_review");
    expect(state.documents[state.documents.length - 1].review_status).toBe("manual_review");
  });

  test("a hash-identical MRR attachment on a second message is linked as a duplicate document, not just a duplicate attachment", async () => {
    const mrrDto = {
      ...baseDto,
      attachments: [
        {
          attachmentId: "gmail-att-mrr-1",
          buffer: pdfBuffer("MRR settlement content"),
          filename: "MRR2602-1-HSPCP00533.pdf",
          mimeType: "application/pdf",
        },
      ],
      gmailMessageId: "gmail-msg-mrr-1",
      rawSubject: "รายงานสรุปข้อมูลบริการตามรอบ 01-15 ก.พ. 2569",
    };
    await ingestNormalizedMessage(mrrDto);

    const mrrDtoAgain = {
      ...mrrDto,
      attachments: [
        {
          attachmentId: "gmail-att-mrr-2",
          buffer: pdfBuffer("MRR settlement content"), // identical bytes -> identical SHA-256
          filename: "MRR2602-1-HSPCP00533.pdf",
          mimeType: "application/pdf",
        },
      ],
      gmailMessageId: "gmail-msg-mrr-2",
    };
    const result = await ingestNormalizedMessage(mrrDtoAgain);

    expect(result.status).toBe("ingested");
    const mrrDocuments = state.documents.filter((doc) => doc.document_type === "settlement_mrr");
    expect(mrrDocuments).toHaveLength(2);
    expect(mrrDocuments[0].review_status).toBe("auto_classified");
    expect(mrrDocuments[1].review_status).toBe("duplicate");
    expect(mrrDocuments[1].duplicate_of_document_id).toBe(mrrDocuments[0].id);
    expect(JSON.parse(JSON.stringify(mrrDocuments[1].reason_codes))).toContain(
      "attachment_checksum_duplicate",
    );
  });

  test("a hash-identical contract attachment on a second message is also linked as a duplicate document", async () => {
    const contractDto = {
      ...baseDto,
      attachments: [
        {
          attachmentId: "gmail-att-contract-1",
          buffer: pdfBuffer("Telepharmacy contract content"),
          filename: "telepharmacy-contract.pdf",
          mimeType: "application/pdf",
        },
      ],
      gmailMessageId: "gmail-msg-contract-1",
      rawSubject: "สัญญา Telepharmacy",
    };
    await ingestNormalizedMessage(contractDto);

    const contractDtoAgain = {
      ...contractDto,
      attachments: [
        {
          attachmentId: "gmail-att-contract-2",
          buffer: pdfBuffer("Telepharmacy contract content"),
          filename: "telepharmacy-contract.pdf",
          mimeType: "application/pdf",
        },
      ],
      gmailMessageId: "gmail-msg-contract-2",
    };
    const result = await ingestNormalizedMessage(contractDtoAgain);

    expect(result.status).toBe("ingested");
    const contractDocuments = state.documents.filter((doc) => doc.document_type === "contract");
    expect(contractDocuments).toHaveLength(2);
    expect(contractDocuments[1].review_status).toBe("duplicate");
    expect(contractDocuments[1].duplicate_of_document_id).toBe(contractDocuments[0].id);
  });

  test("a zero-byte attachment is rejected with empty_attachment and sent to manual review", async () => {
    const dto = {
      ...baseDto,
      attachments: [
        {
          attachmentId: "gmail-att-empty",
          buffer: Buffer.alloc(0),
          filename: "CIV2601000777.pdf",
          mimeType: "application/pdf",
        },
      ],
      gmailMessageId: "gmail-msg-empty",
    };

    const result = await ingestNormalizedMessage(dto);

    expect(result.status).toBe("ingested");
    expect(state.attachments[0].status).toBe("failed");
    expect(JSON.parse(JSON.stringify(state.attachments[0].metadata)).invalidReasons).toContain(
      "empty_attachment",
    );
    expect(state.documents[0].review_status).toBe("manual_review");
    expect(JSON.parse(JSON.stringify(state.documents[0].reason_codes))).toContain("empty_attachment");
    expect(storedFiles).toHaveLength(0);
  });

  // Real-world evidence from a live PharmCare invoice (2026-08-18 dry-run): Gmail reported this
  // attachment's mimeType as application/octet-stream even though it is a genuine PDF. Google's
  // declared type is not authoritative — the PDF magic-byte signature is — so a mismatched
  // declared MIME type must NOT bounce a real PDF to manual_review; it's recorded as evidence
  // only.
  test("an attachment with a mismatched declared MIME type is still ingested when the bytes are a real PDF", async () => {
    const dto = {
      ...baseDto,
      attachments: [
        {
          attachmentId: "gmail-att-octet-stream",
          buffer: pdfBuffer("CIV2601000888 content"),
          filename: "CIV2601000888.pdf",
          mimeType: "application/octet-stream",
        },
      ],
      gmailMessageId: "gmail-msg-octet-stream",
    };

    const result = await ingestNormalizedMessage(dto);

    expect(result.status).toBe("ingested");
    expect(state.attachments[0].status).toBe("stored");
    expect(state.documents[0].review_status).toBe("auto_classified");
    expect(JSON.parse(JSON.stringify(state.documents[0].reason_codes))).toContain(
      "declared_mime_type_mismatch",
    );
    expect(storedFiles).toHaveLength(1);
  });

  test("an attachment whose bytes are genuinely not a PDF is still rejected regardless of declared MIME type", async () => {
    const dto = {
      ...baseDto,
      attachments: [
        {
          attachmentId: "gmail-att-actually-png",
          buffer: Buffer.from("\x89PNG\r\n\x1a\nnot really a pdf"),
          filename: "CIV2601000999.pdf",
          mimeType: "image/png",
        },
      ],
      gmailMessageId: "gmail-msg-actually-png",
    };

    const result = await ingestNormalizedMessage(dto);

    expect(result.status).toBe("ingested");
    expect(state.attachments[0].status).toBe("failed");
    expect(JSON.parse(JSON.stringify(state.attachments[0].metadata)).invalidReasons).toContain(
      "invalid_pdf_signature",
    );
    expect(state.documents[0].review_status).toBe("manual_review");
    expect(storedFiles).toHaveLength(0);
  });

  test("createMessage losing a concurrent-insert race is treated as already_ingested, not an error", async () => {
    const repository = require("../src/modules/seamless/db/pharmcareRepository");

    // Simulates the actual race: at the moment of the fast-path pre-check, no row exists yet
    // (mocked once), so ingestion proceeds into a transaction. A concurrent call "wins" the
    // insert first, so this transaction's own createMessage() sees the unique-constraint
    // conflict and gets ON CONFLICT DO NOTHING's empty result (mocked once). By the time this
    // transaction re-queries findMessageByGmailId() after rolling back, the winner's row is
    // really there (real implementation, not mocked) because it was inserted directly below.
    const winnerMessage = await repository.createMessage({
      mailboxAccount: baseDto.mailboxAccount,
      gmailMessageId: "gmail-msg-race",
      route: "gmail_filter_forward",
      status: "classified",
    });

    const findMessageSpy = jest.spyOn(repository, "findMessageByGmailId").mockImplementationOnce(
      async () => null,
    );
    const createMessageSpy = jest.spyOn(repository, "createMessage").mockResolvedValueOnce(null);

    const result = await ingestNormalizedMessage({ ...baseDto, gmailMessageId: "gmail-msg-race" });

    expect(result.status).toBe("already_ingested");
    expect(result.messageId).toBe(winnerMessage.id);
    // The transaction that lost the race must not have written any attachment/document rows.
    expect(state.attachments).toHaveLength(0);
    expect(state.documents).toHaveLength(0);

    findMessageSpy.mockRestore();
    createMessageSpy.mockRestore();
  });
});
