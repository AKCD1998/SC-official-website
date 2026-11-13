const { Pool } = require("pg");

const connectionString =
  process.env.SC_OFFICIAL_SUPABASE_DATABASE_URL ||
  process.env.SC_OFFICIAL_DATABASE_URL ||
  process.env.DATABASE_URL;
const connectionEnvName = process.env.SC_OFFICIAL_SUPABASE_DATABASE_URL
  ? "SC_OFFICIAL_SUPABASE_DATABASE_URL"
  : process.env.SC_OFFICIAL_DATABASE_URL
    ? "SC_OFFICIAL_DATABASE_URL"
    : "DATABASE_URL";

if (!connectionString) {
  console.error(
    "Main website database URL is missing. Set SC_OFFICIAL_SUPABASE_DATABASE_URL.",
  );
} else {
  console.log(`Main website database env: ${connectionEnvName}`);
}

const isRemoteDb = connectionString &&
  !connectionString.includes("localhost") &&
  !connectionString.includes("127.0.0.1");

// This pool shares Supavisor's session budget with other apps and sync workers.
// Keep room for their connections and for a second instance during a deploy.
const requestedPoolMax = Number(process.env.SC_OFFICIAL_DB_POOL_MAX || 4);
const poolMax = Number.isInteger(requestedPoolMax) && requestedPoolMax >= 2 && requestedPoolMax <= 10
  ? requestedPoolMax
  : 4;

const pool = new Pool({
  application_name: "sc-official-website",
  connectionString,
  connectionTimeoutMillis: 10_000,
  max: poolMax,
  ssl: isRemoteDb ? { rejectUnauthorized: false } : false,
});

module.exports = pool;
