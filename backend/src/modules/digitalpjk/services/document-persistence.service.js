import { pool } from "../db/pool.js";

function normalizeLimit(limit, fallback = 10) {
  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, 50);
}

export async function insertDocumentRecord({ createdBy, branchId, payload }, clientArg = null) {
  const ownsClient = !clientArg;
  const client = clientArg || (await pool.connect());

  try {
    const result = await client.query(
      `
      INSERT INTO documents (
        created_by,
        branch_id,
        payload
      )
      VALUES ($1, $2, $3::jsonb)
      RETURNING id, created_by, branch_id, payload, created_at;
      `,
      [createdBy, branchId, JSON.stringify(payload)]
    );

    return result.rows[0];
  } finally {
    if (ownsClient) {
      client.release();
    }
  }
}

export async function getDocumentById(documentId, clientArg = null) {
  const ownsClient = !clientArg;
  const client = clientArg || (await pool.connect());

  try {
    const result = await client.query(
      `
      SELECT
        d.id,
        d.created_by,
        d.branch_id,
        d.payload,
        d.created_at,
        u.username AS created_by_username,
        b.branch_code
      FROM documents d
      INNER JOIN users u ON u.id = d.created_by
      INNER JOIN branches b ON b.id = d.branch_id
      WHERE d.id = $1
      LIMIT 1;
      `,
      [documentId]
    );

    return result.rows[0] ?? null;
  } finally {
    if (ownsClient) {
      client.release();
    }
  }
}

export async function listRecentDocuments({ limit = 10, branchId = null }, clientArg = null) {
  const ownsClient = !clientArg;
  const client = clientArg || (await pool.connect());
  const safeLimit = normalizeLimit(limit, 10);

  try {
    if (branchId) {
      const result = await client.query(
        `
        SELECT
          d.id,
          d.created_by,
          d.branch_id,
          d.created_at,
          u.username AS created_by_username,
          b.branch_code,
          d.payload->'documentDate'->>'dateISO' AS document_date_iso
        FROM documents d
        INNER JOIN users u ON u.id = d.created_by
        INNER JOIN branches b ON b.id = d.branch_id
        WHERE d.branch_id = $1
        ORDER BY d.created_at DESC
        LIMIT $2;
        `,
        [branchId, safeLimit]
      );

      return result.rows;
    }

    const result = await client.query(
      `
      SELECT
        d.id,
        d.created_by,
        d.branch_id,
        d.created_at,
        u.username AS created_by_username,
        b.branch_code,
        d.payload->'documentDate'->>'dateISO' AS document_date_iso
      FROM documents d
      INNER JOIN users u ON u.id = d.created_by
      INNER JOIN branches b ON b.id = d.branch_id
      ORDER BY d.created_at DESC
      LIMIT $1;
      `,
      [safeLimit]
    );

    return result.rows;
  } finally {
    if (ownsClient) {
      client.release();
    }
  }
}
