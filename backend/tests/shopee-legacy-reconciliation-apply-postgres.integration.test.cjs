const { Pool } = require("pg");

const connectionString = process.env.SC_OFFICIAL_SUPABASE_DATABASE_URL || "";
const runPostgresSmoke = process.env.SEAMLESS_MIGRATION_SMOKE === "1";
const describePostgres = runPostgresSmoke ? describe : describe.skip;

function assertEphemeralDatabase() {
  const schemaName = String(process.env.SEAMLESS_DB_SCHEMA || "").trim();
  if (!/_ci$/u.test(schemaName)) {
    throw new Error(`PostgreSQL integration schema must end in _ci: ${schemaName || "(missing)"}`);
  }
  if (!connectionString) throw new Error("SC_OFFICIAL_SUPABASE_DATABASE_URL is required.");
  const hostname = new URL(connectionString).hostname;
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(hostname)) {
    throw new Error(`PostgreSQL integration database must be local, received host: ${hostname}`);
  }
  return schemaName;
}

describePostgres("Shopee legacy reconciliation controlled apply", () => {
  let directPool;
  let repository;
  let schemaSql;

  beforeAll(async () => {
    schemaSql = `"${assertEphemeralDatabase()}"`;
    directPool = new Pool({ connectionString, ssl: false });
    await directPool.query(`
      TRUNCATE TABLE
        ${schemaSql}.shopee_legacy_reconciliation_apply_items,
        ${schemaSql}.shopee_legacy_reconciliation_apply_batches,
        ${schemaSql}.shopee_legacy_reconciliation_decisions,
        ${schemaSql}.shopee_order_events,
        ${schemaSql}.shopee_orders
      CASCADE
    `);
    // Required only after the CI-only database guard has passed.
    // eslint-disable-next-line global-require
    repository = require("../src/modules/seamless/db/shopeeLegacyReconciliationRepository");
  });

  afterAll(async () => {
    if (directPool) {
      await directPool.query(`
        TRUNCATE TABLE
          ${schemaSql}.shopee_legacy_reconciliation_apply_items,
          ${schemaSql}.shopee_legacy_reconciliation_apply_batches,
          ${schemaSql}.shopee_legacy_reconciliation_decisions,
          ${schemaSql}.shopee_order_events,
          ${schemaSql}.shopee_orders
        CASCADE
      `);
      await directPool.end();
    }
    if (repository) {
      // eslint-disable-next-line global-require
      await require("../db").end();
    }
  });

  test("moves events, creates or merges target orders, and records rollback audit", async () => {
    const createdOrder = "LEGACYCREATE01";
    const mergedOrder = "LEGACYMERGE01";
    await directPool.query(`
      INSERT INTO ${schemaSql}.shopee_orders (
        shop_code, order_number, current_status, items, item_count, total_quantity,
        first_event_at, last_event_at
      ) VALUES
        ('legacy-unattributed', $1, 'order_confirmed', '[]', 0, 0,
          '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
        ('legacy-unattributed', $2, 'order_confirmed', '[]', 0, 0,
          '2026-08-02T00:00:00Z', '2026-08-02T00:00:00Z'),
        ('sc-drug-store', $2, 'shipment_due', '[]', 0, 0,
          '2026-08-02T00:00:00Z', '2026-08-03T00:00:00Z')
    `, [createdOrder, mergedOrder]);
    await directPool.query(`
      INSERT INTO ${schemaSql}.shopee_order_events (
        shop_code, order_number, canonical_message_key, mailbox_account,
        gmail_message_id, event_type, occurred_at
      ) VALUES
        ('legacy-unattributed', $1, $3, 'admin@scgroup1989.com',
          'legacy-create-message', 'order_confirmed', '2026-08-01T00:00:00Z'),
        ('legacy-unattributed', $2, $4, 'admin@scgroup1989.com',
          'legacy-merge-message', 'order_confirmed', '2026-08-02T00:00:00Z')
    `, [
      createdOrder,
      mergedOrder,
      `legacy:${"a".repeat(32)}`,
      `legacy:${"b".repeat(32)}`,
    ]);

    const result = await repository.applyLegacyAttributions({
      attributions: [createdOrder, mergedOrder].map((orderNumber, index) => ({
        decisionSource: "automatic",
        evidenceStatus: "mailbox_match",
        eventCount: 1,
        lastEventAt: index === 0
          ? "2026-08-01T00:00:00.000Z"
          : "2026-08-02T00:00:00.000Z",
        orderNumber,
        targetShopCode: "sc-drug-store",
        targetOrderExisted: index === 1,
      })),
      planDigest: "c".repeat(64),
    });

    expect(result).toMatchObject({
      createdOrderCount: 1,
      eventCount: 2,
      mergedOrderCount: 1,
      orderCount: 2,
      planDigest: "c".repeat(64),
    });
    const legacyCounts = await directPool.query(`
      SELECT
        (SELECT COUNT(*) FROM ${schemaSql}.shopee_orders
          WHERE shop_code = 'legacy-unattributed') AS orders,
        (SELECT COUNT(*) FROM ${schemaSql}.shopee_order_events
          WHERE shop_code = 'legacy-unattributed') AS events
    `);
    expect(Number(legacyCounts.rows[0].orders)).toBe(0);
    expect(Number(legacyCounts.rows[0].events)).toBe(0);

    const target = await directPool.query(`
      SELECT order_number, current_status
      FROM ${schemaSql}.shopee_orders
      WHERE shop_code = 'sc-drug-store'
      ORDER BY order_number
    `);
    expect(target.rows).toEqual([
      { current_status: "order_confirmed", order_number: createdOrder },
      { current_status: "shipment_due", order_number: mergedOrder },
    ]);
    const audit = await directPool.query(`
      SELECT b.order_count, b.event_count, COUNT(i.order_number) AS item_count,
        COUNT(*) FILTER (WHERE i.target_order_existed) AS merged_count
      FROM ${schemaSql}.shopee_legacy_reconciliation_apply_batches b
      JOIN ${schemaSql}.shopee_legacy_reconciliation_apply_items i ON i.batch_id = b.id
      WHERE b.id = $1
      GROUP BY b.order_count, b.event_count
    `, [result.batchId]);
    expect(audit.rows[0]).toMatchObject({
      event_count: 2,
      order_count: 2,
    });
    expect(Number(audit.rows[0].item_count)).toBe(2);
    expect(Number(audit.rows[0].merged_count)).toBe(1);
  });
});
