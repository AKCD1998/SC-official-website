const { Pool } = require("pg");

const connectionString = process.env.SC_OFFICIAL_DATABASE_URL || process.env.DATABASE_URL;
const connectionEnvName = process.env.SC_OFFICIAL_DATABASE_URL
  ? "SC_OFFICIAL_DATABASE_URL"
  : "DATABASE_URL";

if (!connectionString) {
  console.error("Main website database URL is missing. Set SC_OFFICIAL_DATABASE_URL.");
} else {
  console.log(`Main website database env: ${connectionEnvName}`);
}

const isRemoteDb = connectionString &&
  !connectionString.includes("localhost") &&
  !connectionString.includes("127.0.0.1");

const pool = new Pool({
  connectionString,
  ssl: isRemoteDb ? { rejectUnauthorized: false } : false,
});

module.exports = pool;
