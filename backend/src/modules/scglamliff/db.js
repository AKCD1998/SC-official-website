import { Pool } from 'pg';
import { getDatabaseUrl, getPgSslMode } from './config/env.js';

let poolInstance = null;

function buildMissingDatabaseError() {
  const error = new Error('SCGLAMLIFF_DATABASE_URL is not set');
  error.status = 503;
  error.code = 'SCGLAMLIFF_DATABASE_URL_MISSING';
  return error;
}

export function hasDatabase() {
  return Boolean(getDatabaseUrl());
}

export function getPool() {
  const connectionString = getDatabaseUrl();
  if (!connectionString) {
    throw buildMissingDatabaseError();
  }

  if (!poolInstance) {
    const useSsl = getPgSslMode() !== 'disable';
    poolInstance = new Pool({
      connectionString,
      ssl: useSsl ? { rejectUnauthorized: false } : false,
    });
  }

  return poolInstance;
}

const pool = new Proxy(
  {},
  {
    get(_target, prop) {
      const actualPool = getPool();
      const value = actualPool[prop];
      return typeof value === 'function' ? value.bind(actualPool) : value;
    },
  }
);

const query = (text, params) => getPool().query(text, params);

export async function healthCheck() {
  if (!hasDatabase()) {
    return {
      ok: false,
      message: 'SCGLAMLIFF_DATABASE_URL is not set',
    };
  }

  try {
    await query('SELECT 1');
    return { ok: true, message: 'ok' };
  } catch (error) {
    return {
      ok: false,
      message: error?.message || 'Database health check failed',
    };
  }
}

export { pool, query };
