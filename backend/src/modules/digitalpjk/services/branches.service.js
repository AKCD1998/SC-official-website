import { pool } from "../db/pool.js";

export async function listBranches(clientArg = null) {
  const ownsClient = !clientArg;
  const client = clientArg || (await pool.connect());

  try {
    const result = await client.query(
      `
      SELECT
        b.id,
        b.branch_code,
        b.pharmacy_name_th,
        b.branch_name_th,
        b.address_no,
        b.soi,
        b.district,
        b.province,
        b.postcode,
        b.phone,
        b.license_no,
        b.location_text,
        b.operator_title,
        b.operator_work_hours,
        op.display_name_th AS operator_display_name_th
      FROM branches b
      LEFT JOIN LATERAL (
        SELECT u.display_name_th
        FROM users u
        WHERE
          u.branch_id = b.id
          AND u.role = 'user'
          AND u.display_name_th IS NOT NULL
          AND BTRIM(u.display_name_th) <> ''
        ORDER BY u.updated_at DESC, u.created_at DESC, u.id ASC
        LIMIT 1
      ) op ON TRUE
      ORDER BY b.branch_code ASC;
      `
    );

    return result.rows;
  } finally {
    if (ownsClient) {
      client.release();
    }
  }
}

export async function findBranchById(branchId, clientArg = null) {
  const ownsClient = !clientArg;
  const client = clientArg || (await pool.connect());

  try {
    const result = await client.query(
      `
      SELECT
        b.id,
        b.branch_code,
        b.pharmacy_name_th,
        b.branch_name_th,
        b.address_no,
        b.soi,
        b.district,
        b.province,
        b.postcode,
        b.phone,
        b.license_no,
        b.location_text,
        b.operator_title,
        b.operator_work_hours,
        op.display_name_th AS operator_display_name_th
      FROM branches b
      LEFT JOIN LATERAL (
        SELECT u.display_name_th
        FROM users u
        WHERE
          u.branch_id = b.id
          AND u.role = 'user'
          AND u.display_name_th IS NOT NULL
          AND BTRIM(u.display_name_th) <> ''
        ORDER BY u.updated_at DESC, u.created_at DESC, u.id ASC
        LIMIT 1
      ) op ON TRUE
      WHERE b.id = $1
      LIMIT 1;
      `,
      [branchId]
    );

    return result.rows[0] ?? null;
  } finally {
    if (ownsClient) {
      client.release();
    }
  }
}
