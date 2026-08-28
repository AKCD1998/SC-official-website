const { Pool } = require("pg");

const SAFE_FAILURE_CODE = "CONNECTION_OR_READONLY_CHECK_FAILED";
const SAFE_MISSING_SECRET_CODE = "DATABASE_SECRET_MISSING";
const SAFE_SUCCESS_CODE = "READONLY_CONNECTION_OK";

function createPool(connectionString) {
  const isRemote =
    !connectionString.includes("localhost") &&
    !connectionString.includes("127.0.0.1");

  return new Pool({
    connectionString,
    connectionTimeoutMillis: 10_000,
    idle_in_transaction_session_timeout: 10_000,
    max: 1,
    query_timeout: 10_000,
    statement_timeout: 10_000,
    ssl: isRemote ? { rejectUnauthorized: false } : false,
  });
}

async function runReadOnlyCheck({ pool }) {
  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();
    await client.query("BEGIN TRANSACTION READ ONLY");
    transactionStarted = true;

    await client.query("SELECT 1");
    const readOnlyResult = await client.query("SHOW transaction_read_only");
    if (readOnlyResult.rows?.[0]?.transaction_read_only !== "on") {
      throw new Error("Read-only transaction was not enforced.");
    }
  } finally {
    if (client && transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The safe failure code from main is sufficient; never expose database details.
      }
    }
    client?.release();
    await pool.end();
  }
}

async function main({
  env = process.env,
  failureLog = console.error,
  poolFactory = createPool,
  successLog = console.log,
} = {}) {
  const connectionString = env.SC_OFFICIAL_SUPABASE_DATABASE_URL;
  if (!connectionString) {
    failureLog(`[database-check] FAIL ${SAFE_MISSING_SECRET_CODE}`);
    return 1;
  }

  try {
    await runReadOnlyCheck({ pool: poolFactory(connectionString) });
    successLog(`[database-check] OK ${SAFE_SUCCESS_CODE}`);
    return 0;
  } catch {
    failureLog(`[database-check] FAIL ${SAFE_FAILURE_CODE}`);
    return 1;
  }
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  SAFE_FAILURE_CODE,
  SAFE_MISSING_SECRET_CODE,
  SAFE_SUCCESS_CODE,
  createPool,
  main,
  runReadOnlyCheck,
};
