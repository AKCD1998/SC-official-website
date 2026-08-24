const fs = require("node:fs/promises");
const path = require("node:path");
const pool = require("../db");
const { readSchemaName } = require("../src/modules/seamless/config");
const { getTables, quoteIdentifier } = require("../src/modules/seamless/tables");

const migrationsDirectory = path.resolve(
  __dirname,
  "../src/modules/seamless/db/migrations",
);

function assertCiOnlyDatabase() {
  if (process.env.SEAMLESS_MIGRATION_SMOKE !== "1") {
    throw new Error("SEAMLESS_MIGRATION_SMOKE=1 is required for migration smoke verification.");
  }

  const schemaName = readSchemaName();
  if (!/_ci$/u.test(schemaName)) {
    throw new Error(`Migration smoke schema must end in _ci: ${schemaName}`);
  }

  const connectionString = process.env.SC_OFFICIAL_SUPABASE_DATABASE_URL || "";
  const hostname = new URL(connectionString).hostname;
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(hostname)) {
    throw new Error(`Migration smoke database must be local, received host: ${hostname}`);
  }
  return schemaName;
}

async function expectedMigrationFiles() {
  const entries = await fs.readdir(migrationsDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
}

async function verifyInvalidOrderNumberConstraint(client, tables) {
  await client.query("SAVEPOINT invalid_order_number");
  let rejection = null;
  try {
    await client.query(
      `
        INSERT INTO ${tables.shopeeOrders} (
          order_number, current_status, first_event_at, last_event_at
        ) VALUES ('SHORT', 'order_confirmed', now(), now())
      `,
    );
  } catch (error) {
    rejection = error;
  }
  await client.query("ROLLBACK TO SAVEPOINT invalid_order_number");

  if (rejection?.code !== "23514") {
    throw rejection || new Error("Migration accepted an invalid short Shopee order number.");
  }
}

async function verifyValidOrderAndEventInsert(client, tables) {
  const orderNumber = "CISMOKE01";
  await client.query(
    `
      INSERT INTO ${tables.shopeeOrders} (
        order_number, current_status, first_event_at, last_event_at
      ) VALUES ($1, 'order_confirmed', now(), now())
    `,
    [orderNumber],
  );
  await client.query(
    `
      INSERT INTO ${tables.shopeeOrderEvents} (
        order_number, mailbox_account, gmail_message_id, event_type, occurred_at
      ) VALUES ($1, 'ci@example.invalid', 'migration-smoke-message', 'order_confirmed', now())
    `,
    [orderNumber],
  );
}

async function verifyMigrations() {
  const schemaName = assertCiOnlyDatabase();
  const schemaSql = quoteIdentifier(schemaName, "schema");
  const tables = getTables();
  const expectedFiles = await expectedMigrationFiles();
  const client = await pool.connect();

  try {
    await client.query(`SET search_path TO ${schemaSql}, public`);
    const appliedResult = await client.query(
      `SELECT filename FROM ${tables.schemaMigrations} ORDER BY filename`,
    );
    const appliedFiles = new Set(appliedResult.rows.map((row) => row.filename));
    const missingFiles = expectedFiles.filter((filename) => !appliedFiles.has(filename));
    if (missingFiles.length) {
      throw new Error(`Missing Seamless migrations: ${missingFiles.join(", ")}`);
    }

    for (const tableName of ["shopee_orders", "shopee_order_events"]) {
      // eslint-disable-next-line no-await-in-loop
      const result = await client.query("SELECT to_regclass($1) AS relation", [
        `${schemaName}.${tableName}`,
      ]);
      if (!result.rows[0]?.relation) throw new Error(`Missing migrated table: ${tableName}`);
    }

    await client.query("BEGIN");
    try {
      await verifyInvalidOrderNumberConstraint(client, tables);
      await verifyValidOrderAndEventInsert(client, tables);
    } finally {
      await client.query("ROLLBACK");
    }

    console.log(
      `[seamless:migrate:verify] Verified ${expectedFiles.length} migrations in ${schemaName}.`,
    );
  } finally {
    client.release();
  }
}

verifyMigrations()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error("[seamless:migrate:verify] Verification failed.");
    console.error(error);
    await pool.end().catch(() => {});
    process.exitCode = 1;
  });
