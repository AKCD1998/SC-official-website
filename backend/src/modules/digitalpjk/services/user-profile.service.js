import { pool } from "../db/pool.js";

const userBranchSelect = `
  SELECT
    u.id AS user_id,
    u.username,
    u.password_hash,
    u.role,
    u.branch_id AS user_branch_id,
    u.display_name_th,
    b.id AS branch_id,
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
    b.operator_work_hours
  FROM users u
  LEFT JOIN branches b ON b.id = u.branch_id
`;

export async function findUserWithBranchByUsername(username) {
  const result = await pool.query(
    `${userBranchSelect}
     WHERE u.username = $1
     LIMIT 1;`,
    [username]
  );

  return result.rows[0] ?? null;
}

export async function findUserWithBranchById(userId) {
  const result = await pool.query(
    `${userBranchSelect}
     WHERE u.id = $1
     LIMIT 1;`,
    [userId]
  );

  return result.rows[0] ?? null;
}
