import "dotenv/config";
import { Pool } from "pg";

const isProduction = process.env.NODE_ENV === "production";
let realPool = null;

function getDatabaseUrl() {
  return process.env.DIGITALPJK_DATABASE_URL || "";
}

function getPool() {
  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) {
    const error = new Error("DIGITALPJK_DATABASE_URL is not set");
    error.statusCode = 503;
    throw error;
  }

  if (!realPool) {
    realPool = new Pool({
      connectionString: databaseUrl,
      ssl: isProduction ? { rejectUnauthorized: false } : false,
    });
  }

  return realPool;
}

export function hasDatabase() {
  return Boolean(getDatabaseUrl());
}

export async function healthCheck() {
  if (!hasDatabase()) {
    return { ok: false, message: "DIGITALPJK_DATABASE_URL is not set" };
  }

  try {
    const result = await getPool().query("SELECT NOW() AS now");
    return { ok: true, now: result.rows[0]?.now };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

export const pool = {
  connect(...args) {
    return getPool().connect(...args);
  },
  query(...args) {
    return getPool().query(...args);
  },
  end(...args) {
    if (!realPool) {
      return Promise.resolve();
    }

    return realPool.end(...args).finally(() => {
      realPool = null;
    });
  },
};

export async function closePool() {
  await pool.end();
}
