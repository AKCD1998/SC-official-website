const fs = require("node:fs");
const path = require("node:path");

const {
  SAFE_FAILURE_CODE,
  SAFE_MISSING_SECRET_CODE,
  SAFE_SUCCESS_CODE,
  main,
  runReadOnlyCheck,
} = require("../scripts/check-read-only-production-database.cjs");

const workflowPath = path.join(
  __dirname,
  "..",
  "..",
  ".github",
  "workflows",
  "check-production-database-readonly.yml",
);

function createDatabaseDouble({ readOnly = "on", queryFailure } = {}) {
  const query = jest.fn(async (sql) => {
    if (queryFailure && sql === queryFailure.sql) throw queryFailure.error;
    if (sql === "SHOW transaction_read_only") {
      return { rows: [{ transaction_read_only: readOnly }] };
    }
    return { rows: [] };
  });
  const client = { query, release: jest.fn() };
  const pool = { connect: jest.fn(async () => client), end: jest.fn(async () => {}) };
  return { client, pool, query };
}

test("workflow is manual-only, bounded, and grants read-only repository permission", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");
  const triggerBlock = workflow.match(/^on:\r?\n([\s\S]*?)^permissions:/m)?.[1];

  expect(triggerBlock?.trim()).toBe("workflow_dispatch: {}");
  expect(workflow).toContain("permissions:\n  contents: read");
  expect(workflow).toContain("timeout-minutes: 5");
  expect(workflow).toContain(
    "SC_OFFICIAL_SUPABASE_DATABASE_URL: ${{ secrets.SC_OFFICIAL_SUPABASE_DATABASE_URL }}",
  );
  expect(workflow).not.toContain("seamless:shopee:sync");
  expect(workflow).not.toMatch(/migrat(e|ion)/i);
});

test("database probe uses one enforced read-only transaction and always rolls back", async () => {
  const { client, pool, query } = createDatabaseDouble();

  await runReadOnlyCheck({ pool });

  expect(query.mock.calls.map(([sql]) => sql)).toEqual([
    "BEGIN TRANSACTION READ ONLY",
    "SELECT 1",
    "SHOW transaction_read_only",
    "ROLLBACK",
  ]);
  expect(client.release).toHaveBeenCalledTimes(1);
  expect(pool.end).toHaveBeenCalledTimes(1);
});

test("database probe fails closed and rolls back when read-only mode is not active", async () => {
  const { client, pool, query } = createDatabaseDouble({ readOnly: "off" });

  await expect(runReadOnlyCheck({ pool })).rejects.toThrow(
    "Read-only transaction was not enforced.",
  );

  expect(query).toHaveBeenLastCalledWith("ROLLBACK");
  expect(client.release).toHaveBeenCalledTimes(1);
  expect(pool.end).toHaveBeenCalledTimes(1);
});

test("database probe rolls back and closes resources after a query failure", async () => {
  const databaseError = new Error("sensitive database detail");
  const { client, pool, query } = createDatabaseDouble({
    queryFailure: { error: databaseError, sql: "SELECT 1" },
  });

  await expect(runReadOnlyCheck({ pool })).rejects.toBe(databaseError);
  expect(query.mock.calls.map(([sql]) => sql)).toEqual([
    "BEGIN TRANSACTION READ ONLY",
    "SELECT 1",
    "ROLLBACK",
  ]);
  expect(client.release).toHaveBeenCalledTimes(1);
  expect(pool.end).toHaveBeenCalledTimes(1);
});

test("entry point never logs a connection string or database error details", async () => {
  const connectionString = "postgresql://private-user:private-password@private-host/private-db";
  const databaseError = new Error("private-host rejected private-user");
  const failureLog = jest.fn();
  const successLog = jest.fn();
  const exitCode = await main({
    env: { SC_OFFICIAL_SUPABASE_DATABASE_URL: connectionString },
    failureLog,
    poolFactory: jest.fn(() => ({
      connect: jest.fn(async () => { throw databaseError; }),
      end: jest.fn(async () => {}),
    })),
    successLog,
  });

  expect(exitCode).toBe(1);
  expect(successLog).not.toHaveBeenCalled();
  expect(failureLog).toHaveBeenCalledWith(`[database-check] FAIL ${SAFE_FAILURE_CODE}`);
  const loggedText = JSON.stringify(failureLog.mock.calls);
  expect(loggedText).not.toContain(connectionString);
  expect(loggedText).not.toContain(databaseError.message);
});

test("entry point emits only safe codes for missing secret and success", async () => {
  const missingSecretLog = jest.fn();
  await expect(main({ env: {}, failureLog: missingSecretLog })).resolves.toBe(1);
  expect(missingSecretLog).toHaveBeenCalledWith(
    `[database-check] FAIL ${SAFE_MISSING_SECRET_CODE}`,
  );

  const successLog = jest.fn();
  const { pool } = createDatabaseDouble();
  await expect(main({
    env: { SC_OFFICIAL_SUPABASE_DATABASE_URL: "redacted" },
    poolFactory: () => pool,
    successLog,
  })).resolves.toBe(0);
  expect(successLog).toHaveBeenCalledWith(`[database-check] OK ${SAFE_SUCCESS_CODE}`);
});
