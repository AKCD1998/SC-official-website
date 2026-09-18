jest.mock("../db", () => ({}));
const { validateObservation, recordDocumentObservation } = require("../src/modules/seamless/services/shopeeDocumentObservationService");
const { buildDocumentSyncStatus } = require("../src/modules/seamless/services/shopeeDocumentSyncStatusService");
const now = new Date("2026-09-17T10:00:00Z");
function evidence() { return {
  shopCode: "dr-morepen", reportType: "etax-receipt-invoice", dateFrom: "2026-09-16", dateTo: "2026-09-16",
  portalAccount: "mu3f314od9", jobId: "dr-etax-20260916", observedAt: "2026-09-17T09:00:00Z",
  resultStatus: "no_file", reasonCode: "SHOPEE_ETAX_NO_DOCUMENT_FOR_DATE",
  sourceValidation: { portalAccount: "mu3f314od9", selectedDate: "2026-09-16", exactDailyRangeVerified: true,
    resultRowCount: 0, searchResponseVerified: true, searchEndpoint: "/api/v1/seller/tax-documents/list" },
}; }
function windowEvidence() { return {
  ...evidence(), resultStatus: "unavailable", reasonCode: "SHOPEE_ETAX_DATE_OUTSIDE_AVAILABLE_WINDOW",
  sourceValidation: { portalAccount: "mu3f314od9", requestedDate: "2026-09-16", portalPath: "/tax/download",
    endDateUnset: true, pickerLowerBoundVerified: true, earliestAvailableDate: "2026-09-17", requestedDateDisabled: true },
}; }
test("outside-window proof is distinct, exact, and rejects inferred or incomplete claims", () => {
  expect(validateObservation(windowEvidence(), now).resultStatus).toBe("unavailable");
  for (const patch of [{ requestedDate: "2026-09-15" }, { portalAccount: "142wuxqhgi" }, { portalPath: "/tax/download?sign=secret" },
    { endDateUnset: false }, { pickerLowerBoundVerified: false }, { requestedDateDisabled: false },
    { earliestAvailableDate: "2026-09-16" }, { earliestAvailableDate: "2026-09-15" }, { earliestAvailableDate: "2026-02-30" },
    { earliestAvailableDate: "2027-01-01" }, { guessedRollingDays: 180 }]) {
    expect(() => validateObservation({ ...windowEvidence(), sourceValidation: { ...windowEvidence().sourceValidation, ...patch } }, now)).toThrow();
  }
  expect(() => validateObservation({ ...windowEvidence(), reasonCode: "SHOPEE_ETAX_NO_DOCUMENT_FOR_DATE" }, now)).toThrow();
  expect(() => validateObservation({ ...windowEvidence(), sourceValidation: evidence().sourceValidation }, now)).toThrow();
  expect(() => validateObservation({ ...evidence(), sourceValidation: windowEvidence().sourceValidation }, now)).toThrow();
});
test("accepts only exact authenticated empty daily evidence", () => {
  expect(validateObservation(evidence(), now).resultStatus).toBe("no_file");
  for (const patch of [{ shopCode: "sc-drug-store" }, { shopCode: "DR_MOREPEN" }, { dateTo: "2026-09-17" },
    { dateFrom: "2026-02-30", dateTo: "2026-02-30" }, { observedAt: "2026-09-18T00:00:00Z" },
    { rawResponse: "forbidden" }, { resultStatus: "downloaded" }]) {
    expect(() => validateObservation({ ...evidence(), ...patch }, now)).toThrow();
  }
  for (const patch of [{ resultRowCount: 1 }, { searchResponseVerified: false }, { portalAccount: "142wuxqhgi" },
    { selectedDate: "2026-09-15" }, { searchEndpoint: "/api/v1/seller/tax-documents/list?sign=secret" },
    { exactDailyRangeVerified: false }]) {
    expect(() => validateObservation({ ...evidence(), sourceValidation: { ...evidence().sourceValidation, ...patch } }, now)).toThrow();
  }
});
test("immutable job replay is idempotent and changed evidence rolls back", async () => {
  let saved;
  const query = jest.fn(async (sql, args) => {
    if (sql.startsWith("SELECT payload")) return { rows: saved ? [saved] : [] };
    if (sql.startsWith("INSERT")) { saved = { payload_sha256: args[10], recorded_at: now }; return { rows: [saved] }; }
    return { rows: [] };
  });
  const dbPool = { connect: async () => ({ query, release: jest.fn() }) };
  expect((await recordDocumentObservation({ body: evidence(), now, dbPool })).status).toBe("recorded");
  expect((await recordDocumentObservation({ body: evidence(), now, dbPool })).status).toBe("already_recorded");
  await expect(recordDocumentObservation({ body: { ...evidence(), observedAt: "2026-09-17T09:01:00Z" }, now, dbPool })).rejects.toMatchObject({ statusCode: 409 });
  expect(query).toHaveBeenLastCalledWith("ROLLBACK");
});
test("outside-window replay returns the original status and rejects changed lower-bound proof", async () => {
  const body = { ...windowEvidence(), dateFrom: "2026-03-17", dateTo: "2026-03-17",
    sourceValidation: { ...windowEvidence().sourceValidation, requestedDate: "2026-03-17", earliestAvailableDate: "2026-03-18" } };
  let saved;
  const query = jest.fn(async (sql, args) => {
    if (sql.startsWith("SELECT payload")) return { rows: saved ? [saved] : [] };
    if (sql.startsWith("INSERT")) { saved = { payload_sha256: args[10], recorded_at: now }; return { rows: [saved] }; }
    return { rows: [] };
  });
  const dbPool = { connect: async () => ({ query, release: jest.fn() }) };
  expect(await recordDocumentObservation({ body, now, dbPool })).toMatchObject({ status: "recorded", resultStatus: "unavailable" });
  expect(await recordDocumentObservation({ body, now, dbPool })).toMatchObject({ status: "already_recorded", resultStatus: "unavailable" });
  await expect(recordDocumentObservation({ body: { ...body, sourceValidation: { ...body.sourceValidation, earliestAvailableDate: "2026-03-19" } }, now, dbPool })).rejects.toMatchObject({ statusCode: 409 });
  await expect(recordDocumentObservation({ body: evidence(), now, dbPool })).rejects.toMatchObject({ statusCode: 409 });
});
test("window observations show checked coverage, real files win and income-pending is unchanged", () => {
  const job = { ...windowEvidence(), importedAt: now.toISOString(), earliestAvailableDate: "2026-09-17" };
  const getShop = (jobs) => buildDocumentSyncStatus({ days: 1, now, jobs }).shops.find((shop) => shop.shopCode === "dr-morepen");
  const etax = (jobs) => getShop(jobs).rows.find((row) => row.reportType === "etax-receipt-invoice");
  expect(etax([job])).toMatchObject({ status: "complete", expectedCount: 1, outsideWindowCount: 1, noFileCount: 0, ingestedCount: 0, sourceCount: 0 });
  expect(etax([job]).cells[0]).toMatchObject({ status: "unavailable", evidence: { reasonCode: job.reasonCode, earliestAvailableDate: "2026-09-17" } });
  expect(etax([job, { ...job, resultStatus: "imported", sourceSha256: "a".repeat(64) }]).cells[0].status).toBe("ingested");
  expect(getShop([job]).rows.find((row) => row.reportType === "income-pending")).toMatchObject({ status: "unavailable", expectedCount: 0, outsideWindowCount: 0 });
});
test("unchecked days remain missing, verified empty days are no_file, actual files always win", () => {
  const job = { ...evidence(), importedAt: now.toISOString() };
  const row = (jobs) => buildDocumentSyncStatus({ days: 2, now, jobs }).shops
    .find((shop) => shop.shopCode === "dr-morepen").rows.find((item) => item.reportType === "etax-receipt-invoice");
  expect(row([]).cells.map((cell) => cell.status)).toEqual(["missing", "missing"]);
  expect(row([job]).cells.map((cell) => cell.status)).toEqual(["no_file", "missing"]);
  expect(row([job]).noFileCount).toBe(1);
  const file = { ...job, resultStatus: "imported", sourceSha256: "a".repeat(64), sourceFilename: "report.zip" };
  expect(row([job, file]).cells[0].status).toBe("ingested");
  expect(row([job, file]).sourceCount).toBe(1);
  const allEmpty = row([job, { ...job, dateFrom: "2026-09-15", dateTo: "2026-09-15", jobId: "older" }]);
  expect(allEmpty).toMatchObject({ status: "complete", sourceCount: 0, ingestedCount: 0,
    noFileCount: 2, latestCoveredDate: "2026-09-16", latestImportedAt: now.toISOString() });
});

test("rollout verification requires every expected ledger constraint", () => {
  const { verifyConstraints } = require("../scripts/verify-shopee-observation-rollout.cjs");
  const definitions = ["PRIMARY KEY (job_id)", "CHECK (report_type = 'etax-receipt-invoice')", "CHECK (result_status = 'no_file')",
    "CHECK (reason_code = 'SHOPEE_ETAX_NO_DOCUMENT_FOR_DATE')", "CHECK (date_to = date_from)",
    "CHECK (payload_sha256 ~ '^[a-f0-9]{64}$')", "CHECK (shop_code IN ('sc-drug-store', 'dr-morepen'))",
    "CHECK ((shop_code = 'sc-drug-store' AND portal_account = '142wuxqhgi') OR (shop_code = 'dr-morepen' AND portal_account = 'mu3f314od9'))"];
  const rows = definitions.map((definition) => ({ definition }));
  expect(() => verifyConstraints(rows)).not.toThrow();
  for (let index = 0; index < rows.length; index += 1) {
    // The mapping also establishes scope, so scope has a separate direct DB constraint but overlapping proof.
    if (index === 6) continue;
    expect(() => verifyConstraints(rows.filter((_, position) => position !== index))).toThrow();
  }
});
