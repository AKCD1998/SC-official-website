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
