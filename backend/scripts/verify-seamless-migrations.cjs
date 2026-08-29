const fs = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");
const { quoteIdentifier } = require("../src/modules/seamless/tables");

const migrationsDirectory = path.resolve(
  __dirname,
  "../src/modules/seamless/db/migrations",
);
const TEST_DATABASE_ENV = "SEAMLESS_MIGRATION_TEST_DATABASE_URL";
const TEST_SCHEMA_ENV = "SEAMLESS_MIGRATION_TEST_SCHEMA";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const TEST_NAME_PATTERN = /_(?:test|ci)$/iu;

function isLocalContainerAddress(value) {
  const address = String(value || "").toLowerCase();
  if (LOCAL_HOSTS.has(address)) return true;
  const parts = address.split(".").map(Number);
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return parts[0] === 10
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168);
  }
  return address.startsWith("fc") || address.startsWith("fd");
}

function readSafeTestTarget(env = process.env) {
  if (env.SEAMLESS_MIGRATION_SMOKE !== "1") {
    throw new Error("SEAMLESS_MIGRATION_SMOKE=1 is required for migration smoke verification.");
  }

  const connectionString = String(env[TEST_DATABASE_ENV] || "").trim();
  if (!connectionString) {
    throw new Error(`${TEST_DATABASE_ENV} is required; shared/production database env vars are never used.`);
  }

  let target;
  try {
    target = new URL(connectionString);
  } catch (_error) {
    throw new Error(`${TEST_DATABASE_ENV} must be a valid PostgreSQL URL.`);
  }
  if (!new Set(["postgres:", "postgresql:"]).has(target.protocol)) {
    throw new Error(`${TEST_DATABASE_ENV} must use the postgres or postgresql protocol.`);
  }
  if (target.search || target.hash) {
    throw new Error(
      `${TEST_DATABASE_ENV} must not contain query parameters or a URL hash.`,
    );
  }
  if (!LOCAL_HOSTS.has(target.hostname.toLowerCase())) {
    throw new Error("Migration smoke database must be disposable PostgreSQL on localhost.");
  }

  const databaseName = decodeURIComponent(target.pathname.replace(/^\//u, ""));
  if (!databaseName || databaseName.includes("/") || !TEST_NAME_PATTERN.test(databaseName)) {
    throw new Error("Migration smoke database name must end in _test or _ci.");
  }

  const schemaName = String(env[TEST_SCHEMA_ENV] || "").trim();
  if (!schemaName || !TEST_NAME_PATTERN.test(schemaName)) {
    throw new Error(`${TEST_SCHEMA_ENV} must be explicit and end in _test or _ci.`);
  }
  quoteIdentifier(schemaName, "schema");

  return { connectionString, databaseName, schemaName };
}

function testTables(schemaName) {
  const schemaSql = quoteIdentifier(schemaName, "schema");
  const qualify = (name) => `${schemaSql}.${quoteIdentifier(name, "table")}`;
  return {
    adaSmartShopeeJobEvents: qualify("adasmart_shopee_job_events"),
    adaSmartShopeeJobs: qualify("adasmart_shopee_jobs"),
    generatedFiles: qualify("generated_files"),
    processingRecords: qualify("processing_records"),
    schemaMigrations: qualify("schema_migrations"),
    shopeeLegacyReconciliationApplyBatches: qualify("shopee_legacy_reconciliation_apply_batches"),
    shopeeLegacyReconciliationApplyItems: qualify("shopee_legacy_reconciliation_apply_items"),
    shopeeLegacyReconciliationDecisions: qualify("shopee_legacy_reconciliation_decisions"),
    shopeeOrderEvents: qualify("shopee_order_events"),
    shopeeOrders: qualify("shopee_orders"),
    workbookUploads: qualify("workbook_uploads"),
  };
}

async function expectedMigrationFiles() {
  const entries = await fs.readdir(migrationsDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
}

async function applyMigrations(client, schemaName, tables, files) {
  const schemaSql = quoteIdentifier(schemaName, "schema");
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaSql}`);
  await client.query(`SET search_path TO ${schemaSql}, public`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${tables.schemaMigrations} (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const appliedResult = await client.query(`SELECT filename FROM ${tables.schemaMigrations}`);
  const applied = new Set(appliedResult.rows.map((row) => row.filename));

  for (const filename of files) {
    if (applied.has(filename)) continue;
    // eslint-disable-next-line no-await-in-loop
    const sql = await fs.readFile(path.join(migrationsDirectory, filename), "utf8");
    // eslint-disable-next-line no-await-in-loop
    await client.query(sql);
    // eslint-disable-next-line no-await-in-loop
    await client.query(`INSERT INTO ${tables.schemaMigrations} (filename) VALUES ($1)`, [filename]);
  }
}

async function expectSqlState(client, savepoint, expectedCodes, label, operation) {
  if (!/^[a-z][a-z0-9_]*$/u.test(savepoint)) throw new Error(`Invalid savepoint: ${savepoint}`);
  await client.query(`SAVEPOINT ${savepoint}`);
  let rejection = null;
  try {
    await operation();
  } catch (error) {
    rejection = error;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await client.query(`RELEASE SAVEPOINT ${savepoint}`);

  if (!rejection || !expectedCodes.includes(rejection.code)) {
    throw rejection || new Error(`${label} was unexpectedly accepted.`);
  }
}

async function verifyInvalidOrderNumberConstraint(client, tables) {
  await expectSqlState(client, "invalid_order_number", ["23514"], "Invalid Shopee order number", () => (
    client.query(
      `
        INSERT INTO ${tables.shopeeOrders} (
          shop_code, order_number, current_status, first_event_at, last_event_at
        ) VALUES ('sc-drug-store', 'SHORT', 'order_confirmed', now(), now())
      `,
    )
  ));
}

async function verifyValidOrderAndEventInsert(client, tables) {
  const orderNumber = "CISMOKE01";
  await client.query(
    `
      INSERT INTO ${tables.shopeeOrders} (
        shop_code, order_number, current_status, first_event_at, last_event_at
      ) VALUES
        ('sc-drug-store', $1, 'order_confirmed', now(), now()),
        ('dr-morepen', $1, 'order_confirmed', now(), now())
    `,
    [orderNumber],
  );
  await client.query(
    `
      INSERT INTO ${tables.shopeeOrderEvents} (
        shop_code, order_number, canonical_message_key, mailbox_account,
        gmail_message_id, event_type, occurred_at
      ) VALUES (
        'sc-drug-store', $1, $2, 'ci@example.invalid',
        'migration-smoke-message', 'order_confirmed', now()
      )
    `,
    [orderNumber, `sha256:${"a".repeat(64)}`],
  );

  const countResult = await client.query(
    `SELECT COUNT(*) AS count FROM ${tables.shopeeOrders} WHERE order_number = $1`,
    [orderNumber],
  );
  if (Number(countResult.rows[0]?.count) !== 2) {
    throw new Error("Composite Shopee order identity did not preserve both shops.");
  }

  await expectSqlState(client, "canonical_duplicate", ["23505"], "Canonical duplicate event", () => (
    client.query(
      `
        INSERT INTO ${tables.shopeeOrderEvents} (
          shop_code, order_number, canonical_message_key, mailbox_account,
          gmail_message_id, event_type, occurred_at
        ) VALUES (
          'dr-morepen', $1, $2, 'forwarded@example.invalid',
          'different-gmail-id', 'order_confirmed', now()
        )
      `,
      [orderNumber, `sha256:${"a".repeat(64)}`],
    )
  ));
}

function adaSmartJobFixture(overrides = {}) {
  return {
    branchCode: "004",
    confirmationAuthSource: "admin_basic",
    confirmedBy: "ci-reviewer",
    customerCode: "CUST-SHOPEE-004",
    customerPolicyKey: "branch-004:shopee-credit-customer",
    customerPolicyRevision: "customer-policy-ci-v1",
    cycleContractRevision: "cycle-ci-v1",
    cycleKey: "2026-08-24_to_2026-09-13",
    documentType: "standard_credit_quotation",
    erpSourceChecksum: "e".repeat(64),
    orderNumber: "CISMOKEJOB01",
    payload: { lines: [{ barcode: "8850000000001", companySku: "CI-SKU-1", quantity: 1 }] },
    periodEnd: "2026-09-13",
    periodStart: "2026-08-24",
    planDigest: "a".repeat(64),
    productCatalogDigest: "c".repeat(64),
    productCatalogVersion: "catalog-ci-v1",
    processingRecordId: "10000000-0000-4000-8000-000000000001",
    shopCode: "dr-morepen",
    sourceChecksumSha256: "b".repeat(64),
    sourceFileId: "30000000-0000-4000-8000-000000000001",
    uploadId: "20000000-0000-4000-8000-000000000001",
    ...overrides,
  };
}

async function insertAdaSmartJob(client, tables, overrides = {}) {
  const job = adaSmartJobFixture(overrides);
  return client.query(
    `
      INSERT INTO ${tables.adaSmartShopeeJobs} (
        processing_record_id, upload_id, source_file_id, source_checksum_sha256,
        plan_digest, branch_code, shop_code, order_number, document_type, cycle_key,
        period_start, period_end, cycle_contract_revision, product_catalog_version,
        product_catalog_digest, erp_source_checksum, customer_policy_key, customer_code,
        customer_policy_revision, confirmed_by, confirmation_auth_source, payload, current_status
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22::jsonb, 'queued_dry_run'
      )
      RETURNING id
    `,
    [
      job.processingRecordId,
      job.uploadId,
      job.sourceFileId,
      job.sourceChecksumSha256,
      job.planDigest,
      job.branchCode,
      job.shopCode,
      job.orderNumber,
      job.documentType,
      job.cycleKey,
      job.periodStart,
      job.periodEnd,
      job.cycleContractRevision,
      job.productCatalogVersion,
      job.productCatalogDigest,
      job.erpSourceChecksum,
      job.customerPolicyKey,
      job.customerCode,
      job.customerPolicyRevision,
      job.confirmedBy,
      job.confirmationAuthSource,
      JSON.stringify(job.payload),
    ],
  );
}

async function verifyAdaSmartRequiredColumns(client, schemaName) {
  const required = {
    adasmart_shopee_job_events: ["actor", "auth_source"],
    adasmart_shopee_jobs: [
      "customer_policy_key",
      "customer_code",
      "customer_policy_revision",
      "confirmed_by",
      "confirmation_auth_source",
    ],
  };
  for (const [tableName, columns] of Object.entries(required)) {
    // eslint-disable-next-line no-await-in-loop
    const result = await client.query(
      `
        SELECT column_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND column_name = ANY($3::text[])
      `,
      [schemaName, tableName, columns],
    );
    const notNullColumns = new Set(result.rows
      .filter((row) => row.is_nullable === "NO")
      .map((row) => row.column_name));
    const missing = columns.filter((column) => !notNullColumns.has(column));
    if (missing.length) {
      throw new Error(`${tableName} does not enforce required columns: ${missing.join(", ")}`);
    }
  }
}

async function verifyAdaSmartMigrationContract(client, schemaName, tables) {
  await verifyAdaSmartRequiredColumns(client, schemaName);
  const fixture = adaSmartJobFixture();
  await client.query(
    `
      INSERT INTO ${tables.processingRecords} (id, report_date_key, report_type, filename)
      VALUES ($1, '20260828', 'shopee', 'ci-review.xlsx')
    `,
    [fixture.processingRecordId],
  );
  await client.query(
    `
      INSERT INTO ${tables.workbookUploads} (
        id, processing_record_id, original_filename, requested_variant, status
      ) VALUES ($1, $2, 'Order.all.ci.xlsx', 'shopee', 'processed')
    `,
    [fixture.uploadId, fixture.processingRecordId],
  );
  await client.query(
    `
      INSERT INTO ${tables.generatedFiles} (
        id, processing_record_id, upload_id, file_kind, filename,
        storage_provider, checksum_sha256
      ) VALUES ($1, $2, $3, 'source_upload', 'Order.all.ci.xlsx', 'local', $4)
    `,
    [fixture.sourceFileId, fixture.processingRecordId, fixture.uploadId, fixture.sourceChecksumSha256],
  );

  const inserted = await insertAdaSmartJob(client, tables);
  const jobId = inserted.rows[0].id;

  await expectSqlState(client, "job_effect_duplicate", ["23505"], "Duplicate AdaSmart effect", () => (
    insertAdaSmartJob(client, tables, { planDigest: "d".repeat(64) })
  ));

  const invalidJobFields = [
    ["empty_policy_key", { customerPolicyKey: "", orderNumber: "CIGATEJOB01" }],
    ["empty_customer_code", { customerCode: "", orderNumber: "CIGATEJOB02" }],
    ["empty_policy_revision", { customerPolicyRevision: "", orderNumber: "CIGATEJOB03" }],
    ["empty_confirmation_actor", { confirmedBy: "", orderNumber: "CIGATEJOB04" }],
    ["invalid_confirmation_auth", { confirmationAuthSource: "internal_token", orderNumber: "CIGATEJOB05" }],
  ];
  for (const [savepoint, overrides] of invalidJobFields) {
    // eslint-disable-next-line no-await-in-loop
    await expectSqlState(client, savepoint, ["23514"], savepoint, () => (
      insertAdaSmartJob(client, tables, overrides)
    ));
  }

  await expectSqlState(client, "event_confirmation_auth", ["23514"], "Non-human confirmation event", () => (
    client.query(
      `
        INSERT INTO ${tables.adaSmartShopeeJobEvents} (job_id, status, actor, auth_source)
        VALUES ($1, 'confirmed', 'ci-worker', 'internal_worker')
      `,
      [jobId],
    )
  ));
  await expectSqlState(client, "event_empty_actor", ["23514"], "Empty event actor", () => (
    client.query(
      `
        INSERT INTO ${tables.adaSmartShopeeJobEvents} (job_id, status, actor, auth_source)
        VALUES ($1, 'confirmed', '', 'admin_basic')
      `,
      [jobId],
    )
  ));

  const eventResult = await client.query(
    `
      INSERT INTO ${tables.adaSmartShopeeJobEvents} (job_id, status, actor, auth_source)
      VALUES ($1, 'confirmed', 'ci-reviewer', 'admin_basic')
      RETURNING id
    `,
    [jobId],
  );
  const eventId = eventResult.rows[0].id;

  await expectSqlState(client, "job_core_immutable", ["P0001"], "AdaSmart immutable core update", () => (
    client.query(
      `UPDATE ${tables.adaSmartShopeeJobs} SET customer_code = 'OTHER-CUSTOMER' WHERE id = $1`,
      [jobId],
    )
  ));
  await expectSqlState(client, "event_immutable", ["P0001"], "AdaSmart event update", () => (
    client.query(
      `UPDATE ${tables.adaSmartShopeeJobEvents} SET actor = 'other-reviewer' WHERE id = $1`,
      [eventId],
    )
  ));
  await expectSqlState(client, "event_no_delete", ["P0001"], "AdaSmart event delete", () => (
    client.query(`DELETE FROM ${tables.adaSmartShopeeJobEvents} WHERE id = $1`, [eventId])
  ));
  await expectSqlState(client, "job_no_delete", ["P0001"], "AdaSmart job delete", () => (
    client.query(`DELETE FROM ${tables.adaSmartShopeeJobs} WHERE id = $1`, [jobId])
  ));
}

async function verifyDatabaseIdentity(client, expectedDatabaseName) {
  const result = await client.query("SELECT current_database() AS database_name, inet_server_addr() AS server_addr");
  const databaseName = String(result.rows[0]?.database_name || "");
  const serverAddress = result.rows[0]?.server_addr === null
    ? null
    : String(result.rows[0]?.server_addr || "");
  if (databaseName !== expectedDatabaseName || !TEST_NAME_PATTERN.test(databaseName)) {
    throw new Error("Connected database identity is not the approved _test/_ci database.");
  }
  if (serverAddress && !isLocalContainerAddress(serverAddress)) {
    throw new Error("Connected PostgreSQL server is not local/private-container PostgreSQL.");
  }
}

async function verifyMigrations(env = process.env) {
  const target = readSafeTestTarget(env);
  const tables = testTables(target.schemaName);
  const expectedFiles = await expectedMigrationFiles();
  const pool = new Pool({ connectionString: target.connectionString, max: 1, ssl: false });
  const client = await pool.connect();

  try {
    await verifyDatabaseIdentity(client, target.databaseName);
    await applyMigrations(client, target.schemaName, tables, expectedFiles);

    const appliedResult = await client.query(
      `SELECT filename FROM ${tables.schemaMigrations} ORDER BY filename`,
    );
    const appliedFiles = new Set(appliedResult.rows.map((row) => row.filename));
    const missingFiles = expectedFiles.filter((filename) => !appliedFiles.has(filename));
    if (missingFiles.length) throw new Error(`Missing Seamless migrations: ${missingFiles.join(", ")}`);

    for (const tableName of [
      "shopee_orders",
      "shopee_order_events",
      "shopee_legacy_reconciliation_decisions",
      "shopee_legacy_reconciliation_apply_batches",
      "shopee_legacy_reconciliation_apply_items",
      "adasmart_shopee_jobs",
      "adasmart_shopee_job_events",
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const result = await client.query("SELECT to_regclass($1) AS relation", [
        `${target.schemaName}.${tableName}`,
      ]);
      if (!result.rows[0]?.relation) throw new Error(`Missing migrated table: ${tableName}`);
    }

    await client.query("BEGIN");
    try {
      await verifyInvalidOrderNumberConstraint(client, tables);
      await verifyValidOrderAndEventInsert(client, tables);
      await verifyAdaSmartMigrationContract(client, target.schemaName, tables);
    } finally {
      await client.query("ROLLBACK");
    }

    console.log(
      `[seamless:migrate:verify] Verified ${expectedFiles.length} migrations, including 012, in local ${target.databaseName}/${target.schemaName}.`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  verifyMigrations().catch((error) => {
    console.error("[seamless:migrate:verify] Verification failed.");
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  readSafeTestTarget,
  verifyMigrations,
};
