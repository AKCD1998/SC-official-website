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
});
