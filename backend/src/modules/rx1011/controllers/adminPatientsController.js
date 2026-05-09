import { query } from "../db/pool.js";
import { httpError } from "../utils/httpError.js";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 250;

function toCleanText(value) {
  return String(value ?? "").trim();
}

function normalizeListLimit(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_LIST_LIMIT;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw httpError(400, "limit must be a positive integer");
  }

  return Math.min(Math.floor(numeric), MAX_LIST_LIMIT);
}

function normalizeOffset(value) {
  if (value === undefined || value === null || value === "") {
    return 0;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw httpError(400, "offset must be a non-negative integer");
  }

  return Math.floor(numeric);
}

export async function listAdminPatients(req, res) {
  const searchTerm = toCleanText(req.query.q || req.query.search);
  const limit = normalizeListLimit(req.query.limit);
  const offset = normalizeOffset(req.query.offset);

  const params = [];
  const where = ["1=1"];

  if (searchTerm) {
    params.push(`%${searchTerm}%`);
    where.push(`
      (
        pa.pid ILIKE $${params.length}
        OR pa.full_name ILIKE $${params.length}
        OR COALESCE(pa.address_raw_text, '') ILIKE $${params.length}
        OR COALESCE(pa.district, '') ILIKE $${params.length}
        OR COALESCE(pa.province, '') ILIKE $${params.length}
        OR COALESCE(pa.postal_code, '') ILIKE $${params.length}
      )
    `);
  }

  const countResult = await query(
    `
      SELECT COUNT(*)::int AS total
      FROM patients pa
      WHERE ${where.join(" AND ")}
    `,
    params
  );

  const total = Number(countResult.rows[0]?.total || 0);

  params.push(limit);
  params.push(offset);

  const rowsResult = await query(
    `
      SELECT
        pa.id,
        pa.pid,
        pa.full_name AS "fullName",
        pa.birth_date::text AS "birthDate",
        pa.sex::text AS sex,
        pa.card_issue_place AS "cardIssuePlace",
        pa.card_issued_date::text AS "cardIssuedDate",
        pa.card_expiry_date::text AS "cardExpiryDate",
        pa.address_raw_text AS "addressText",
        pa.address_line1 AS "addressLine1",
        pa.address_line2 AS "addressLine2",
        pa.subdistrict,
        pa.district,
        pa.province,
        pa.postal_code AS "postalCode",
        pa.country,
        pa.created_at AS "createdAt",
        pa.updated_at AS "updatedAt",
        COALESCE(ds."dispenseCount", 0)::int AS "dispenseCount",
        ds."lastDispensedAt"
      FROM patients pa
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS "dispenseCount",
          MAX(dh.dispensed_at) AS "lastDispensedAt"
        FROM dispense_headers dh
        WHERE dh.patient_id = pa.id
      ) ds ON true
      WHERE ${where.join(" AND ")}
      ORDER BY pa.full_name ASC, pa.pid ASC
      LIMIT $${params.length - 1}
      OFFSET $${params.length}
    `,
    params
  );

  return res.json({
    items: rowsResult.rows,
    total,
    limit,
    offset,
  });
}
