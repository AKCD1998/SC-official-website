const fs = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");

const connectionString = process.env.SC_OFFICIAL_SUPABASE_DATABASE_URL || "";
const runPostgresSmoke = process.env.SEAMLESS_MIGRATION_SMOKE === "1";
const describePostgres = runPostgresSmoke ? describe : describe.skip;
const migrationsDirectory = path.resolve(
  __dirname,
  "../src/modules/seamless/db/migrations",
);

function assertEphemeralDatabase() {
  const configuredSchema = String(process.env.SEAMLESS_DB_SCHEMA || "").trim();
  if (!/_ci$/u.test(configuredSchema)) {
    throw new Error(
      `PostgreSQL integration schema must end in _ci: ${configuredSchema || "(missing)"}`,
    );
  }
  if (!connectionString) {
    throw new Error("SC_OFFICIAL_SUPABASE_DATABASE_URL is required for PostgreSQL integration.");
  }
  const hostname = new URL(connectionString).hostname;
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(hostname)) {
    throw new Error(`PostgreSQL integration database must be local, received host: ${hostname}`);
  }
}

describePostgres("Shopee shop-isolation legacy migration PostgreSQL integration", () => {
  let client;
  let pool;
  const schemaName = `shopee_legacy_${process.pid}_ci`;
  const schemaSql = `"${schemaName}"`;

  beforeAll(async () => {
    assertEphemeralDatabase();
    pool = new Pool({ connectionString, ssl: false });
    client = await pool.connect();
    await client.query(`CREATE SCHEMA ${schemaSql}`);
    await client.query(`SET search_path TO ${schemaSql}, public`);
  });

  afterAll(async () => {
    if (client) {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA ${schemaSql} CASCADE`);
      client.release();
    }
    if (pool) await pool.end();
  });

  test("quarantines existing 008 rows without guessing a real shop", async () => {
    const filenames = (await fs.readdir(migrationsDirectory))
      .filter((filename) => filename.endsWith(".sql"))
      .sort();
    const legacyMigrations = filenames.filter((filename) => filename < "009_");
    for (const filename of legacyMigrations) {
      // eslint-disable-next-line no-await-in-loop
      const sql = await fs.readFile(path.join(migrationsDirectory, filename), "utf8");
      // eslint-disable-next-line no-await-in-loop
      await client.query(sql);
    }

    await client.query(
      `
        INSERT INTO shopee_orders (
          order_number, current_status, first_event_at, last_event_at
        ) VALUES ('LEGACY001', 'order_confirmed', now(), now())
      `,
    );
    await client.query(
      `
        INSERT INTO shopee_order_events (
          order_number, mailbox_account, gmail_message_id, event_type, occurred_at
        ) VALUES (
          'LEGACY001', 'legacy@example.invalid', 'legacy-gmail-id', 'order_confirmed', now()
        )
      `,
    );

    const migration009 = await fs.readFile(
      path.join(migrationsDirectory, "009_shopee_order_shop_isolation.sql"),
      "utf8",
    );
    await client.query(migration009);

    const orderResult = await client.query(
      "SELECT shop_code, order_number FROM shopee_orders WHERE order_number = 'LEGACY001'",
    );
    const eventResult = await client.query(
      `
        SELECT shop_code, canonical_message_key
        FROM shopee_order_events
        WHERE order_number = 'LEGACY001'
      `,
    );
    expect(orderResult.rows).toEqual([{
      order_number: "LEGACY001",
      shop_code: "legacy-unattributed",
    }]);
    expect(eventResult.rows[0]).toMatchObject({ shop_code: "legacy-unattributed" });
    expect(eventResult.rows[0].canonical_message_key).toMatch(/^legacy:[a-f0-9]{32}$/u);
    expect(JSON.stringify({ orderResult, eventResult })).not.toMatch(
      /sc-drug-store|dr-morepen/u,
    );
  });
});
