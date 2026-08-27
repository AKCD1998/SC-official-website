const crypto = require("node:crypto");
const { Pool } = require("pg");

const connectionString = process.env.SC_OFFICIAL_SUPABASE_DATABASE_URL || "";
const runPostgresSmoke = process.env.SEAMLESS_MIGRATION_SMOKE === "1";
const describePostgres = runPostgresSmoke ? describe : describe.skip;

function assertEphemeralDatabase() {
  const schemaName = String(process.env.SEAMLESS_DB_SCHEMA || "").trim();
  if (!/_ci$/u.test(schemaName)) {
    throw new Error(`PostgreSQL integration schema must end in _ci: ${schemaName || "(missing)"}`);
  }
  if (!connectionString) {
    throw new Error("SC_OFFICIAL_SUPABASE_DATABASE_URL is required for PostgreSQL integration.");
  }
  const hostname = new URL(connectionString).hostname;
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(hostname)) {
    throw new Error(`PostgreSQL integration database must be local, received host: ${hostname}`);
  }
  return schemaName;
}

function canonical(label) {
  return `sha256:${crypto.createHash("sha256").update(label).digest("hex")}`;
}

function parsed({ canonicalMessageKey, gmailMessageId, orderNumber, shopCode }) {
  const occurredAt = "2026-08-27T08:00:00.000Z";
  return {
    event: {
      canonicalMessageKey,
      details: {},
      eventType: "shipment_due",
      gmailMessageId,
      gmailThreadId: `thread-${gmailMessageId}`,
      mailboxAccount: `${shopCode}@example.invalid`,
      occurredAt,
      orderNumber,
      shopCode,
    },
    order: {
      currentStatus: "shipment_due",
      firstEventAt: occurredAt,
      items: [],
      lastEventAt: occurredAt,
      orderNumber,
      shopCode,
    },
  };
}

describePostgres("Shopee order shop-isolation PostgreSQL integration", () => {
  let directPool;
  let repository;
  let schemaSql;

  beforeAll(async () => {
    const schemaName = assertEphemeralDatabase();
    schemaSql = `"${schemaName}"`;
    directPool = new Pool({ connectionString, ssl: false });
    await directPool.query(`TRUNCATE TABLE ${schemaSql}.shopee_order_events, ${schemaSql}.shopee_orders`);
    // Required only after the CI-only database guard has passed.
    // eslint-disable-next-line global-require
    repository = require("../src/modules/seamless/db/shopeeOrderRepository");
  });

  afterAll(async () => {
    if (directPool) {
      await directPool.query(`TRUNCATE TABLE ${schemaSql}.shopee_order_events, ${schemaSql}.shopee_orders`);
      await directPool.end();
    }
    if (repository) {
      // Close the singleton required by the repository after the isolated integration suite.
      // eslint-disable-next-line global-require
      await require("../db").end();
    }
  });

  test("keeps the same order number independently in both shops", async () => {
    const orderNumber = "CROSSSHOP01";
    await repository.upsertOrderEvent(parsed({
      canonicalMessageKey: canonical("sc-order"),
      gmailMessageId: "sc-gmail",
      orderNumber,
      shopCode: "sc-drug-store",
    }));
    await repository.upsertOrderEvent(parsed({
      canonicalMessageKey: canonical("dr-order"),
      gmailMessageId: "dr-gmail",
      orderNumber,
      shopCode: "dr-morepen",
    }));

    const [scList, drList, scDetail, drDetail] = await Promise.all([
      repository.listOrders({ shopCode: "sc-drug-store" }),
      repository.listOrders({ shopCode: "dr-morepen" }),
      repository.getOrderTimeline("sc-drug-store", orderNumber),
      repository.getOrderTimeline("dr-morepen", orderNumber),
    ]);

    expect(scList.orders.map((order) => [order.shopCode, order.orderNumber]))
      .toContainEqual(["sc-drug-store", orderNumber]);
    expect(drList.orders.map((order) => [order.shopCode, order.orderNumber]))
      .toContainEqual(["dr-morepen", orderNumber]);
    expect(scDetail.order.shopCode).toBe("sc-drug-store");
    expect(drDetail.order.shopCode).toBe("dr-morepen");
    expect(scDetail.events.every((event) => event.shopCode === "sc-drug-store")).toBe(true);
    expect(drDetail.events.every((event) => event.shopCode === "dr-morepen")).toBe(true);
  });

  test("deduplicates a forwarded email across mailboxes before creating the second-shop order", async () => {
    const canonicalMessageKey = canonical("same-forwarded-email");
    const first = await repository.upsertOrderEvent(parsed({
      canonicalMessageKey,
      gmailMessageId: "mailbox-a-gmail-id",
      orderNumber: "FORWARD001",
      shopCode: "sc-drug-store",
    }));
    const forwarded = await repository.upsertOrderEvent(parsed({
      canonicalMessageKey,
      gmailMessageId: "mailbox-b-gmail-id",
      orderNumber: "WRONGSHOP01",
      shopCode: "dr-morepen",
    }));

    expect(first.eventCreated).toBe(true);
    expect(forwarded).toMatchObject({
      duplicateShopCode: "sc-drug-store",
      eventCreated: false,
      order: null,
    });
    const wrongShopCount = await directPool.query(
      `SELECT COUNT(*) AS count FROM ${schemaSql}.shopee_orders WHERE shop_code = $1 AND order_number = $2`,
      ["dr-morepen", "WRONGSHOP01"],
    );
    expect(Number(wrongShopCount.rows[0].count)).toBe(0);
  });
});
