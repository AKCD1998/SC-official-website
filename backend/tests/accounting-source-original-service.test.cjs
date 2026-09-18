const { createService } = require(
  "../src/modules/seamless/services/accountingSourceOriginalService",
);

test("stores a validated monthly statement separately from the print queue", async () => {
  const row = {
    id: "00000000-0000-4000-8000-000000000001",
    document_kind: "statement",
    end_date: "2026-08-31",
    page_count: 3,
    period_type: "monthly",
    shop_code: "sc-drug-store",
    source_filename: "monthly_report_20260801.pdf",
    source_sha256: "a".repeat(64),
    start_date: "2026-08-01",
  };
  const client = {
    query: jest.fn(async (sql) => {
      if (String(sql).includes("SELECT *")) return { rows: [] };
      if (String(sql).includes("INSERT INTO")) return { rows: [row] };
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  const db = { connect: jest.fn().mockResolvedValue(client) };
  const inspectSource = jest.fn().mockResolvedValue({
    checksumSha256: "a".repeat(64),
    end: "2026-08-31",
    filename: "monthly_report_20260801.pdf",
    kind: "statement",
    pageCount: 3,
    periodType: "monthly",
    shopCode: "sc-drug-store",
    start: "2026-08-01",
  });
  const storage = {
    writeStoredFile: jest.fn().mockResolvedValue({
      checksumSha256: "a".repeat(64),
      fileSizeBytes: 3,
      storageBucket: "documents",
      storagePath: "accounting/monthly.pdf",
      storageProvider: "r2",
    }),
  };
  const service = createService({ db, inspectSource, storage });

  const result = await service.uploadSourceOriginals([{
    buffer: Buffer.from("pdf"),
    originalname: "monthly_report_20260801.pdf",
  }], "sc-drug-store", "admin");

  expect(result.sources[0]).toMatchObject({
    filename: "monthly_report_20260801.pdf",
    periodType: "monthly",
    shopCode: "sc-drug-store",
  });
  expect(storage.writeStoredFile).toHaveBeenCalledWith(
    "accounting_source_original",
    "monthly_report_20260801.pdf",
    expect.any(Buffer),
  );
  expect(client.query.mock.calls.some(([sql]) => String(sql).includes("accounting_source_originals"))).toBe(true);
  expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining("accounting_print_batches"));
  expect(client.release).toHaveBeenCalled();
});

test("rejects a source whose parsed report type is not a weekly or monthly statement", async () => {
  const service = createService({
    db: { connect: jest.fn() },
    inspectSource: jest.fn().mockResolvedValue({ kind: "income" }),
    storage: { writeStoredFile: jest.fn() },
  });

  await expect(service.uploadSourceOriginals([{
    buffer: Buffer.from("xlsx"),
    originalname: "Income.xlsx",
  }], "sc-drug-store", "admin")).rejects.toThrow(/PDF รายงานการเงิน/u);
});
