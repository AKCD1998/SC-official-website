const {
  createService,
  importAccountingIncomeSources,
  parseAccountingIncomeSources,
} = require("../src/modules/seamless/services/accountingOriginalPrintService");

const sha = "a".repeat(64);
const source = {
  control: { orderCount: 1, transferredTotal: 125.5 },
  endDate: "2026-09-01",
  facts: [],
  observedAt: "2026-09-02T03:00:00.000Z",
  reportType: "income-transferred",
  shopCode: "sc-drug-store",
  sourceFilename: "Income.โอนเงินสำเร็จ.th.20260901_20260901.xlsx",
  sourceSha256: sha,
  startDate: "2026-09-01",
};

test("accounting Income parsing delegates to the canonical strict parser", async () => {
  const buffer = Buffer.from("xlsx bytes");
  const readIncome = jest.fn(async () => source);
  const result = await parseAccountingIncomeSources(
    [{
      buffer,
      fieldname: "sc-drug-store",
      originalname: source.sourceFilename,
    }],
    { items: [{
      checksumSha256: sha,
      end: source.endDate,
      filename: source.sourceFilename,
      kind: "income",
      shopCode: source.shopCode,
      start: source.startDate,
    }] },
    { observedAt: source.observedAt, readIncome },
  );
  expect(result).toEqual([source]);
  expect(readIncome).toHaveBeenCalledWith(buffer, {
    observedAt: source.observedAt,
    reportType: "income-transferred",
    shopCode: source.shopCode,
    sourceFilename: source.sourceFilename,
    sourceSha256: sha,
  });
});

test("exact-SHA replay keeps existing canonical provenance and does not re-import", async () => {
  const client = { query: jest.fn(async (sql) => (
    /SELECT source_sha256/iu.test(sql)
      ? { rows: [{ source_sha256: sha, shop_code: source.shopCode, report_type: source.reportType }] }
      : { rows: [] }
  )) };
  const importer = jest.fn();
  const result = await importAccountingIncomeSources(
    client,
    { shopeeOfficialDocumentSources: "test.shopee_official_document_sources" },
    [source],
    "admin",
    importer,
  );
  expect(result).toEqual({ imported: 0, unchanged: 1 });
  expect(importer).not.toHaveBeenCalled();
});

test("new accounting Income source imports inside the caller transaction", async () => {
  const client = { query: jest.fn(async () => ({ rows: [] })) };
  const importer = jest.fn(async () => ({ imported: 1, unchanged: 0 }));
  await expect(importAccountingIncomeSources(
    client,
    { shopeeOfficialDocumentSources: "test.shopee_official_document_sources" },
    [source],
    "finance-admin",
    importer,
  )).resolves.toEqual({ imported: 1, unchanged: 0 });
  expect(importer).toHaveBeenCalledWith([source], {
    actor: "accounting-print-bundle:finance-admin",
    client,
    manageTransaction: false,
  });
});

test("createBatch backfills canonical Income in its transaction before returning an existing fingerprint", async () => {
  const batchId = "11111111-1111-4111-8111-111111111111";
  const manifest = {
    fingerprint: "existing-fingerprint",
    items: [{
      checksumSha256: sha,
      end: source.endDate,
      filename: source.sourceFilename,
      kind: "income",
      shopCode: source.shopCode,
      start: source.startDate,
    }],
  };
  const calls = [];
  const client = {
    query: jest.fn(async (sql) => {
      calls.push(sql);
      if (/SELECT source_sha256/iu.test(sql)) return { rows: [] };
      if (/WHERE fingerprint=\$1/iu.test(sql)) return { rows: [{ id: batchId }] };
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  const db = {
    connect: jest.fn(async () => client),
    query: jest.fn(async (sql) => {
      if (/SELECT \* FROM test\.accounting_print_batches/iu.test(sql)) {
        return { rows: [{
          id: batchId,
          fingerprint: manifest.fingerprint,
          manifest,
          title: "existing batch",
          status: "review",
          agent_host: "agent",
          printer_name: "printer",
          created_at: new Date("2026-09-01T00:00:00.000Z"),
        }] };
      }
      return { rows: [] };
    }),
  };
  const importer = jest.fn(async (_sources, options) => {
    calls.push("IMPORT_CANONICAL_INCOME");
    expect(options.client).toBe(client);
    expect(calls[0]).toBe("BEGIN");
    expect(calls).not.toContain("COMMIT");
    return { imported: 1, unchanged: 0 };
  });
  const service = createService({
    db,
    tables: () => ({
      accountingPrintBatches: "test.accounting_print_batches",
      accountingPrintItems: "test.accounting_print_items",
      accountingPrintNotifications: "test.accounting_print_notifications",
      shopeeOfficialDocumentSources: "test.shopee_official_document_sources",
    }),
    parseFiles: jest.fn(async () => manifest),
    readIncome: jest.fn(async () => source),
    importOfficialSources: importer,
    target: () => ({ agentHost: "agent", printerName: "printer", webUrl: "" }),
  });

  await expect(service.createBatch([{
    buffer: Buffer.from("xlsx bytes"),
    fieldname: source.shopCode,
    originalname: source.sourceFilename,
  }], "finance-admin")).resolves.toMatchObject({ id: batchId });

  expect(importer).toHaveBeenCalledWith([source], {
    actor: "accounting-print-bundle:finance-admin",
    client,
    manageTransaction: false,
  });
  expect(calls.indexOf("IMPORT_CANONICAL_INCOME"))
    .toBeLessThan(calls.findIndex((sql) => /WHERE fingerprint=\$1/iu.test(sql)));
  expect(calls.at(-1)).toBe("COMMIT");
  expect(client.release).toHaveBeenCalledTimes(1);
});
