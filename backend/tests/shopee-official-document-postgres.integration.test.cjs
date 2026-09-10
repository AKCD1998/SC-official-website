const { Pool } = require("pg");

const runPostgresSmoke = process.env.SEAMLESS_MIGRATION_SMOKE === "1";
const describePostgres = runPostgresSmoke ? describe : describe.skip;

function assertEphemeralTarget() {
  const connectionString = String(process.env.SEAMLESS_MIGRATION_TEST_DATABASE_URL || "").trim();
  const schemaName = String(process.env.SEAMLESS_DB_SCHEMA || "").trim();
  if (!connectionString || !/_test$/u.test(schemaName)) {
    throw new Error("Official-document PostgreSQL test requires an explicit local _test target.");
  }
  const { hostname } = new URL(connectionString);
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(hostname)) {
    throw new Error("Official-document PostgreSQL test target must be local.");
  }
  return connectionString;
}

function source({ hashCharacter, reportType, control, facts }) {
  return {
    shopCode: "sc-drug-store",
    sourceSha256: hashCharacter.repeat(64),
    reportType,
    sourceFilename: `${reportType}-test`,
    observedAt: "2026-09-10T03:00:00.000Z",
    startDate: "2026-08-31",
    endDate: "2026-09-06",
    control,
    facts,
  };
}

describePostgres("official Shopee document repository PostgreSQL integration", () => {
  let client;
  let pool;
  let repository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: assertEphemeralTarget(), ssl: false });
    client = await pool.connect();
    repository = require("../src/modules/seamless/db/shopeeOfficialDocumentRepository");
    await client.query("BEGIN");
  });

  afterAll(async () => {
    if (client) {
      await client.query("ROLLBACK");
      client.release();
    }
    if (pool) await pool.end();
  });

  test("atomically imports, replays and reads every official-document fact shape", async () => {
    const orderNumber = "260901TEST001";
    const sources = [
      source({
        hashCharacter: "a",
        reportType: "financial-statement",
        control: { transferredTotal: 100 },
        facts: [{ shopCode: "sc-drug-store", transferredTotal: 100, pageCount: 3 }],
      }),
      source({
        hashCharacter: "b",
        reportType: "income-transferred",
        control: { transferredTotal: 100, orderCount: 1 },
        facts: [{
          shopCode: "sc-drug-store",
          sourceRow: 7,
          orderNumber,
          returnRequestNumber: null,
          orderedAt: "2026-08-31T02:00:00.000Z",
          transferredAt: "2026-09-01T03:00:00.000Z",
          payoutAmount: 100,
          components: { buyerPaid: 120, fees: -20 },
        }],
      }),
      source({
        hashCharacter: "c",
        reportType: "seller-balance",
        control: { orderTotal: 100, orderCount: 1, adjustmentTotal: 0, adjustmentCount: 0 },
        facts: [{
          shopCode: "sc-drug-store",
          sourceRow: 19,
          transactionAt: "2026-09-01T03:00:00.000Z",
          transactionType: "รายรับจากคำสั่งซื้อ",
          orderNumber,
          direction: "เงินเข้า",
          amount: 100,
          status: "ทำรายการสำเร็จ",
          balanceAfter: 1000,
        }],
      }),
      source({
        hashCharacter: "d",
        reportType: "return-refund-cancel",
        control: { counts: { cancelled: 1, failed_delivery: 0, return_refund: 0 } },
        facts: [{
          shopCode: "sc-drug-store",
          eventKey: `cancelled:${orderNumber}`,
          eventType: "cancelled",
          orderNumber,
          returnRequestNumber: null,
          orderedAt: "2026-09-01T02:00:00.000Z",
          eventAt: null,
          status: "ยกเลิกแล้ว",
          reason: "ผู้ซื้อยกเลิก",
          amountLabel: "ราคาขายสุทธิ",
          amount: 120,
          entryFilename: "Order.cancelled.test.xlsx",
          sourceRows: [2],
        }],
      }),
    ];

    await expect(repository.importOfficialDocumentSources(sources, {
      client,
      actor: "postgres-integration-test",
      manageTransaction: false,
    })).resolves.toEqual({ imported: 4, unchanged: 0 });
    await expect(repository.importOfficialDocumentSources(sources, {
      client,
      actor: "postgres-integration-test",
      manageTransaction: false,
    })).resolves.toEqual({ imported: 0, unchanged: 4 });

    const finance = await repository.listFinanceSources({
      client,
      shopCode: "sc-drug-store",
      startDate: "2026-08-31",
      endDate: "2026-09-06",
    });
    expect(finance.map((item) => item.report_type).sort()).toEqual([
      "financial-statement",
      "income-transferred",
      "seller-balance",
    ]);
    await expect(repository.listReconciliationFacts({
      client,
      sourceSha256: "b".repeat(64),
      reportType: "income-transferred",
      shopCode: "sc-drug-store",
    })).resolves.toHaveLength(1);
    await expect(repository.listReconciliationFacts({
      client,
      sourceSha256: "c".repeat(64),
      reportType: "seller-balance",
      shopCode: "sc-drug-store",
    })).resolves.toHaveLength(1);

    const returns = await repository.listReturnSourcesAndFacts({
      client,
      shopCode: "sc-drug-store",
      startDate: "2026-09-01",
      endDate: "2026-09-01",
    });
    expect(returns.sources).toHaveLength(1);
    expect(returns.facts).toMatchObject([{
      event_type: "cancelled",
      order_number: orderNumber,
      amount_label: "ราคาขายสุทธิ",
    }]);
  });
});
