process.env.SEAMLESS_DB_SCHEMA = "clasp_scx_seamless";

const state = { attachments: [], documents: [], messages: [], runs: [], syncState: null };
let messageSeq = 0;
let attachmentSeq = 0;
let documentSeq = 0;
let runSeq = 0;
let lockAcquired = true;

function resetState() {
  state.messages = [];
  state.attachments = [];
  state.documents = [];
  state.runs = [];
  state.syncState = null;
  messageSeq = 0;
  attachmentSeq = 0;
  documentSeq = 0;
  runSeq = 0;
  lockAcquired = true;
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

async function mockQuery(sql, params = []) {
  const text = normalizeSql(sql);

  if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
    return { rows: [], rowCount: 0 };
  }

  if (text.startsWith("SELECT pg_try_advisory_lock(")) {
    return { rows: [{ acquired: lockAcquired }], rowCount: 1 };
  }

  if (text.startsWith("SELECT pg_advisory_unlock(")) {
    return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
  }

  if (text.startsWith('INSERT INTO "clasp_scx_seamless"."pharmcare_sync_runs"')) {
    runSeq += 1;
    const run = {
      id: `run-${runSeq}`,
      mailbox_account: params[0],
      run_kind: params[1],
      status: params[2] || "running",
      message_count: 0,
      outcome_counts: {},
      errors: [],
      checkpoint: {},
      started_at: new Date().toISOString(),
      finished_at: null,
    };
    state.runs.push(run);
    return { rows: [run], rowCount: 1 };
  }

  if (text.startsWith('UPDATE "clasp_scx_seamless"."pharmcare_sync_runs"')) {
    const run = state.runs.find((r) => r.id === params[0]);
    if (run) {
      run.status = params[1];
      run.message_count = params[2];
      run.outcome_counts = JSON.parse(params[3]);
      run.errors = JSON.parse(params[4]);
      run.checkpoint = JSON.parse(params[5]);
      run.finished_at = new Date().toISOString();
    }
    return { rows: [], rowCount: run ? 1 : 0 };
  }

  if (text.startsWith('SELECT * FROM "clasp_scx_seamless"."pharmcare_sync_state"')) {
    return { rows: state.syncState ? [state.syncState] : [], rowCount: state.syncState ? 1 : 0 };
  }

  if (text.startsWith('INSERT INTO "clasp_scx_seamless"."pharmcare_sync_state"')) {
    state.syncState = {
      mailbox_account: params[0],
      checkpoint: JSON.parse(params[1]),
      last_run_status: params[2],
      last_run_finished_at: params[3],
    };
    return { rows: [state.syncState], rowCount: 1 };
  }

  if (
    text.startsWith('SELECT * FROM "clasp_scx_seamless"."pharmcare_email_messages" WHERE id = $1')
  ) {
    const row = state.messages.find((msg) => msg.id === params[0]);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
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
const { runPharmcareGmailSync, syncMessagesFromAdapter } = require("../src/modules/seamless/services/pharmcareSyncService");

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

  test("a transient adapter failure is retried and succeeds within the attempt budget", async () => {
    const attachmentData = pdfBuffer("CIV2601000111 retry content");
    let getMessageCalls = 0;
    const adapter = {
      listCandidateMessageIds: async () => ["gmail-retry-1"],
      getMessage: async () => {
        getMessageCalls += 1;
        if (getMessageCalls === 1) {
          throw new Error("transient Gmail 500");
        }
        return createMockGmailAdapter([
          {
            attachments: [{ attachmentId: "att-1", data: attachmentData }],
            id: "gmail-retry-1",
            internalDate: "1767229200000",
            payload: {
              headers: [
                { name: "From", value: "PharmCare <info@pharmcare.co>" },
                { name: "Subject", value: "PharmCare e-credit invoice CIV2601000111" },
              ],
              parts: [
                {
                  body: { attachmentId: "att-1", size: attachmentData.length },
                  filename: "CIV2601000111.pdf",
                  mimeType: "application/pdf",
                },
              ],
            },
          },
        ]).getMessage("gmail-retry-1");
      },
      getAttachment: async () => attachmentData,
    };

    const results = await syncMessagesFromAdapter(adapter, "admin@scgroup1989.com", { retryDelayMs: 1 });

    expect(getMessageCalls).toBe(2);
    expect(results[0].status).toBe("ingested");
    expect(state.messages).toHaveLength(1);
  });

  test("a permanently failing message exhausts its attempts and is reported failed once", async () => {
    let getMessageCalls = 0;
    const adapter = {
      listCandidateMessageIds: async () => ["gmail-retry-2"],
      getMessage: async () => {
        getMessageCalls += 1;
        throw new Error("Gmail is down");
      },
      getAttachment: async () => Buffer.alloc(0),
    };

    const results = await syncMessagesFromAdapter(adapter, "admin@scgroup1989.com", { retryDelayMs: 1 });

    expect(getMessageCalls).toBe(3);
    expect(results).toEqual([
      { error: "Gmail is down", gmailMessageId: "gmail-retry-2", status: "failed" },
    ]);
  });
});

describe("pharmcareSyncService.runPharmcareGmailSync (lock + checkpoint + metrics)", () => {
  function makeFixtureAdapter(id, receivedAtMs, attachmentData) {
    return createMockGmailAdapter([
      {
        attachments: [{ attachmentId: "att-1", data: attachmentData }],
        id,
        internalDate: String(receivedAtMs),
        payload: {
          headers: [
            { name: "From", value: "PharmCare <info@pharmcare.co>" },
            { name: "Subject", value: `PharmCare e-credit invoice ${id}` },
          ],
          parts: [
            { body: { data: base64("hello") }, mimeType: "text/plain" },
            {
              body: { attachmentId: "att-1", size: attachmentData.length },
              filename: `${id}.pdf`,
              mimeType: "application/pdf",
            },
          ],
        },
      },
    ]);
  }

  test("records a completed run, updates the checkpoint, and stores outcome metrics", async () => {
    const receivedAtMs = Date.parse("2026-08-01T10:00:00Z");
    const adapter = makeFixtureAdapter("CIV2601000999", receivedAtMs, pdfBuffer("CIV2601000999 content"));

    const outcome = await runPharmcareGmailSync(adapter, "admin@scgroup1989.com");

    expect(outcome.status).toBe("completed");
    expect(outcome.results[0].status).toBe("ingested");
    // Checkpoint = the newest successfully ingested message's receivedAt.
    expect(outcome.checkpoint.newestReceivedAt).toBe(new Date(receivedAtMs).toISOString());
    expect(state.syncState.checkpoint.newestReceivedAt).toBe(new Date(receivedAtMs).toISOString());
    expect(state.syncState.last_run_status).toBe("completed");

    const run = state.runs.find((r) => r.id === outcome.runId);
    expect(run.status).toBe("completed");
    expect(run.message_count).toBe(1);
    expect(run.outcome_counts).toEqual({ ingested: 1 });
  });

  test("returns lock_busy and does not touch Gmail or messages when another sync holds the lock", async () => {
    lockAcquired = false;
    const adapter = makeFixtureAdapter("CIV2601000888", Date.now(), pdfBuffer("CIV2601000888 content"));

    const outcome = await runPharmcareGmailSync(adapter, "admin@scgroup1989.com");

    expect(outcome.status).toBe("lock_busy");
    expect(outcome.results).toEqual([]);
    expect(state.messages).toHaveLength(0);
    // Contention is observable: a lock_busy run row exists.
    const busyRun = state.runs.find((r) => r.status === "lock_busy");
    expect(busyRun).toBeDefined();
  });

  test("an incremental run resumes from the stored checkpoint via listCandidateMessageIds(after)", async () => {
    const checkpointTime = new Date("2026-08-01T10:00:00Z");
    state.syncState = {
      mailbox_account: "admin@scgroup1989.com",
      checkpoint: { newestReceivedAt: checkpointTime.toISOString() },
      last_run_status: "completed",
      last_run_finished_at: null,
    };
    let seenAfter = "not called";
    const adapter = {
      listCandidateMessageIds: async ({ after } = {}) => {
        seenAfter = after || null;
        return [];
      },
      getAttachment: async () => Buffer.alloc(0),
      getMessage: async () => {
        throw new Error("should not be called");
      },
    };

    const outcome = await runPharmcareGmailSync(adapter, "admin@scgroup1989.com");

    expect(seenAfter).toBe(checkpointTime.toISOString());
    expect(outcome.status).toBe("completed");
  });

  test("a backfill over older history records its checkpoint on the run row but never moves the state checkpoint backwards", async () => {
    const stateCheckpointTime = new Date("2026-08-10T10:00:00Z");
    state.syncState = {
      mailbox_account: "admin@scgroup1989.com",
      checkpoint: { newestReceivedAt: stateCheckpointTime.toISOString() },
      last_run_status: "completed",
      last_run_finished_at: null,
    };
    // Backfill scans an OLD message (older than the state checkpoint) and ingests it.
    const oldReceivedAtMs = Date.parse("2026-08-01T10:00:00Z");
    const adapter = makeFixtureAdapter("CIV2601000777", oldReceivedAtMs, pdfBuffer("CIV2601000777 content"));

    const outcome = await runPharmcareGmailSync(adapter, "admin@scgroup1989.com", {
      ignoreCheckpoint: true,
      runKind: "backfill",
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.results[0].status).toBe("ingested");

    // The run row keeps the evidence of what the backfill scanned...
    const run = state.runs.find((r) => r.id === outcome.runId);
    expect(run.run_kind).toBe("backfill");
    expect(run.checkpoint.newestReceivedAt).toBe(new Date(oldReceivedAtMs).toISOString());

    // ...but the resume checkpoint that incremental syncs use is untouched.
    expect(state.syncState.checkpoint.newestReceivedAt).toBe(stateCheckpointTime.toISOString());
    expect(state.syncState.last_run_status).toBe("completed");
  });
});
