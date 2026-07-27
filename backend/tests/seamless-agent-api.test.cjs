const express = require("express");
const request = require("supertest");

// This suite deliberately does NOT follow this backend's usual mock-SQL Jest convention (see
// seamless-processing-records.test.cjs) — it hits a REAL disposable Postgres via DATABASE_URL.
// Mocked SQL cannot catch the concurrency bugs (queued-row leaks, duplicate rows, disguised-201
// double-print) that real reproduction against Postgres caught across the ClaspSCxSeamless
// project's 12 review rounds (see docs/10-print-agent-tasks.md / docs/11-print-agent-review-ledger.md
// in that repo, and backend/docs/seamless-print-agent-testing.md in this one).
const testDatabaseUrl = process.env.DATABASE_URL || "";

if (testDatabaseUrl) {
  process.env.SEAMLESS_DB_SCHEMA = "clasp_scx_seamless";
}
process.env.SEAMLESS_INTERNAL_API_TOKEN = "seamless-agent-test-token";

const describeOrSkip = testDatabaseUrl ? describe : describe.skip;

describeOrSkip("seamless auto-print agent API (real Postgres)", () => {
  let pool;
  let seamlessRoutes;
  let processingRecords;
  let printJobRepository;
  let app;

  beforeAll(async () => {
    // Fresh require cache per Jest test file — safe to set env vars before requiring.
    pool = require("../db");
    seamlessRoutes = require("../src/modules/seamless/routes");
    processingRecords = require("../src/modules/seamless/processingRecords");
    printJobRepository = require("../src/modules/seamless/db/printJobRepository");

    app = express();
    app.use(express.json());
    app.use("/api", seamlessRoutes);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createRecord(overrides = {}) {
    return processingRecords.createProcessingRecord({
      filename: `test-agent-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`,
      reportType: "individual",
      reportDate: "20260728",
      sourceUploadName: "source.xlsx",
      ...overrides,
    });
  }

  async function cleanup(recordId) {
    await pool.query(
      "DELETE FROM clasp_scx_seamless.print_jobs WHERE processing_record_id = $1",
      [recordId],
    );
    await pool.query("DELETE FROM clasp_scx_seamless.processing_records WHERE id = $1", [recordId]);
  }

  test("GET /api/agent/print-queue rejects requests without a bearer token", async () => {
    const response = await request(app).get("/api/agent/print-queue");
    expect(response.status).toBe(401);
  });

  test("GET /api/agent/print-queue returns an empty queue when nothing needs printing", async () => {
    const response = await request(app)
      .get("/api/agent/print-queue")
      .set("Authorization", "Bearer seamless-agent-test-token");
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.queue)).toBe(true);
  });

  test("full reprint cycle: request-print -> agent claims -> completes -> record does not reappear in queue", async () => {
    const record = await createRecord();

    try {
      const requestPrintResponse = await request(app)
        .post(`/api/app/processing-records/${record.id}/request-print`)
        .set("Authorization", "Bearer seamless-agent-test-token")
        .send({ requestedBy: "front-desk", reason: "document_lost" });
      expect(requestPrintResponse.status).toBe(200);

      const queueBefore = await request(app)
        .get("/api/agent/print-queue")
        .set("Authorization", "Bearer seamless-agent-test-token");
      const ourEntry = queueBefore.body.queue.find((doc) => doc.processingRecordId === record.id);
      expect(ourEntry).toBeTruthy();

      const createResponse = await request(app)
        .post("/api/agent/print-jobs")
        .set("Authorization", "Bearer seamless-agent-test-token")
        .send({ processingRecordId: record.id, agentHost: "000-HQ", printerName: "Brother MFC-T4500DW" });
      expect(createResponse.status).toBe(201);

      const rowCount = await pool.query(
        "SELECT count(*)::int AS count FROM clasp_scx_seamless.print_jobs WHERE processing_record_id = $1",
        [record.id],
      );
      // Baseline row created by request-print, claimed by the agent — must stay 1, not 2.
      expect(rowCount.rows[0].count).toBe(1);

      const completeResponse = await request(app)
        .post(`/api/agent/print-jobs/${createResponse.body.job.id}/complete`)
        .set("Authorization", "Bearer seamless-agent-test-token")
        .send({});
      expect(completeResponse.status).toBe(200);

      const queueAfter = await request(app)
        .get("/api/agent/print-queue")
        .set("Authorization", "Bearer seamless-agent-test-token");
      expect(queueAfter.body.queue.some((doc) => doc.processingRecordId === record.id)).toBe(false);
    } finally {
      await cleanup(record.id);
    }
  });

  // This is the exact regression that ClaspSCxSeamless's R12 fixed: a naive DB-row-count check
  // is NOT sufficient — every concurrent caller must be checked individually. Before R12, all
  // callers here would have received HTTP 201 with the SAME job, which is indistinguishable
  // from success to a print-agent with no ownership check of its own; it would have downloaded
  // and physically printed the document once per losing caller.
  test("10 truly concurrent POST /api/agent/print-jobs for the same record: exactly one winner (201), the rest get 409", async () => {
    const record = await createRecord();
    const adminQueuedJob = await printJobRepository.createPrintJob({
      processingRecordId: record.id,
      requestedBy: "front-desk",
      reprintReason: "document_lost",
      documentUploadedAt: record.uploadedAt,
    });

    try {
      const createJobRequest = (agentHost) =>
        request(app)
          .post("/api/agent/print-jobs")
          .set("Authorization", "Bearer seamless-agent-test-token")
          .send({ processingRecordId: record.id, agentHost, printerName: "Brother MFC-T4500DW" });

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) => createJobRequest(`agent-${index}`)),
      );

      const winners = results.filter((result) => result.status === 201);
      const losers = results.filter((result) => result.status === 409);

      expect(winners.length).toBe(1);
      expect(losers.length).toBe(9);
      expect(winners[0].body.job.id).toBe(adminQueuedJob.id);
      losers.forEach((loser) => {
        expect(loser.body.error.code).toBe("CONFLICT");
      });

      const rowCount = await pool.query(
        "SELECT count(*)::int AS count FROM clasp_scx_seamless.print_jobs WHERE processing_record_id = $1",
        [record.id],
      );
      expect(rowCount.rows[0].count).toBe(1);
    } finally {
      await cleanup(record.id);
    }
  });

  test("requestPrint rolls back the mark-unprinted if creating the print job fails", async () => {
    // metadata.outputFileId feeds generated_file_id, a uuid FK column — a malformed value
    // forces the INSERT inside the same transaction to fail, so this proves the R8 fix
    // (BEGIN/COMMIT/ROLLBACK via one shared client) actually rolls back the mark-unprinted
    // update too, instead of leaving the record silently unprinted with no tracked request.
    const record = await createRecord({
      printed: true,
      metadata: { outputFileId: "not-a-valid-uuid" },
    });

    try {
      const processingRecordAppService = require("../src/modules/seamless/services/processingRecordAppService");

      await expect(
        processingRecordAppService.requestPrint(record.id, { requestedBy: "front-desk" }),
      ).rejects.toThrow();

      const afterFailure = await processingRecords.getProcessingRecordById(record.id);
      expect(afterFailure.printed).toBe(true);
      expect(afterFailure.lastAction).not.toBe("print_requested");

      const activeJobs = await pool.query(
        "SELECT count(*)::int AS count FROM clasp_scx_seamless.print_jobs WHERE processing_record_id = $1",
        [record.id],
      );
      expect(activeJobs.rows[0].count).toBe(0);
    } finally {
      await cleanup(record.id);
    }
  });
});
