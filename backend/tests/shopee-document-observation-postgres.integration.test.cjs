const { Pool } = require("pg");
const suite = process.env.SEAMLESS_MIGRATION_SMOKE === "1" ? describe : describe.skip;
suite("document observation PostgreSQL ledger", () => {
  let pool;
  let table;
  let service;
  const jobId = `ci-etax-observation-${process.pid}-${Date.now()}`;
  beforeAll(() => {
    const connectionString = process.env.SEAMLESS_MIGRATION_TEST_DATABASE_URL;
    if (!connectionString || !["localhost", "127.0.0.1", "::1"].includes(new URL(connectionString).hostname)
      || !/_(?:test|ci)$/u.test(process.env.SEAMLESS_DB_SCHEMA || "")) throw new Error("Requires local CI DB/schema.");
    pool = new Pool({ connectionString, ssl: false });
    table = require("../src/modules/seamless/tables").getTables().shopeeDocumentObservations;
    service = require("../src/modules/seamless/services/shopeeDocumentObservationService");
  });
  afterAll(async () => {
    if (pool) { await pool.query(`DELETE FROM ${table} WHERE job_id = ANY($1::text[])`, [[jobId, `${jobId}-window`]]); await pool.end(); }
  });
  test("persists exact metadata, replays idempotently, rejects conflicting replay, and reads coverage", async () => {
    const body = { shopCode: "dr-morepen", reportType: "etax-receipt-invoice", dateFrom: "2026-09-16", dateTo: "2026-09-16",
      portalAccount: "mu3f314od9", jobId, observedAt: "2026-09-17T09:00:00Z", resultStatus: "no_file",
      reasonCode: "SHOPEE_ETAX_NO_DOCUMENT_FOR_DATE", sourceValidation: { portalAccount: "mu3f314od9", selectedDate: "2026-09-16",
        exactDailyRangeVerified: true, resultRowCount: 0, searchResponseVerified: true, searchEndpoint: "/api/v1/seller/tax-documents/list" } };
    const input = { body, dbPool: pool, now: new Date("2026-09-17T10:00:00Z") };
    expect((await service.recordDocumentObservation(input)).status).toBe("recorded");
    expect((await service.recordDocumentObservation(input)).status).toBe("already_recorded");
    await expect(service.recordDocumentObservation({ ...input, body: { ...body, observedAt: "2026-09-17T09:01:00Z" } }))
      .rejects.toMatchObject({ statusCode: 409 });
    const rows = await require("../src/modules/seamless/db/shopeeDocumentSyncStatusRepository").listSuccessfulIngestJobs({
      client: pool, startDate: "2026-09-16", endDate: "2026-09-16",
    });
    expect(rows.find((row) => row.jobId === jobId)).toMatchObject({ resultStatus: "no_file", dateFrom: "2026-09-16", portalAccount: "mu3f314od9" });
    expect((await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE job_id=$1`, [jobId])).rows[0].count).toBe(1);
  });
  test("migration 026 enforces window proof and preserves immutable observations", async () => {
    const body = { shopCode: "dr-morepen", reportType: "etax-receipt-invoice", dateFrom: "2026-03-17", dateTo: "2026-03-17",
      portalAccount: "mu3f314od9", jobId: `${jobId}-window`, observedAt: "2026-09-18T09:00:00Z", resultStatus: "unavailable",
      reasonCode: "SHOPEE_ETAX_DATE_OUTSIDE_AVAILABLE_WINDOW", sourceValidation: { portalAccount: "mu3f314od9", requestedDate: "2026-03-17",
        portalPath: "/tax/download", endDateUnset: true, pickerLowerBoundVerified: true, earliestAvailableDate: "2026-03-18", requestedDateDisabled: true } };
    const input = { body, dbPool: pool, now: new Date("2026-09-18T10:00:00Z") };
    expect(await service.recordDocumentObservation(input)).toMatchObject({ status: "recorded", resultStatus: "unavailable" });
    expect(await service.recordDocumentObservation(input)).toMatchObject({ status: "already_recorded", resultStatus: "unavailable" });
    const constraints = await pool.query(`SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass`, [table]);
    const { verifyWindowConstraints } = require("../scripts/verify-shopee-etax-window-rollout.cjs");
    expect(() => verifyWindowConstraints(constraints.rows)).not.toThrow();
    for (const proof of [{}, { ...body.sourceValidation, requestedDateDisabled: false },
      { ...body.sourceValidation, earliestAvailableDate: "2026-03-17" }, { ...body.sourceValidation, portalPath: "/login" }]) {
      await expect(pool.query(`UPDATE ${table} SET source_validation=$1::jsonb WHERE job_id=$2`, [JSON.stringify(proof), body.jobId])).rejects.toMatchObject({ code: "23514" });
    }
    await expect(pool.query(`UPDATE ${table} SET reason_code='SHOPEE_ETAX_NO_DOCUMENT_FOR_DATE' WHERE job_id=$1`, [body.jobId])).rejects.toMatchObject({ code: "23514" });
    const rows = await require("../src/modules/seamless/db/shopeeDocumentSyncStatusRepository").listSuccessfulIngestJobs({ client: pool, startDate: body.dateFrom, endDate: body.dateTo });
    expect(rows.find((row) => row.jobId === body.jobId)).toMatchObject({ resultStatus: "unavailable", earliestAvailableDate: "2026-03-18" });
  });
});
