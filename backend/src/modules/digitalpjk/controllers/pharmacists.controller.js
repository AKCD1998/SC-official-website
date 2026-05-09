import { pool } from "../db/pool.js";

function mapPartTimePharmacistRow(row) {
  const pharmacistTitle = row.pharmacist_title || "";
  const pharmacistName = row.pharmacist_name || "";

  return {
    id: row.id,
    display_name: `${pharmacistTitle} ${pharmacistName}`.trim(),
    pharmacist_title: pharmacistTitle,
    pharmacist_name: pharmacistName,
    license_number: row.license_number || "",
  };
}

export async function listPartTimePharmacistsHandler(_req, res, next) {
  try {
    const result = await pool.query(
      `
      SELECT
        license_id_number::text AS id,
        pharmacist_title,
        pharmacist_name,
        license_id_number::text AS license_number
      FROM part_time_pharmacists
      ORDER BY pharmacist_name ASC, pharmacist_title ASC, license_id_number ASC;
      `
    );

    return res.status(200).json({
      pharmacists: result.rows.map(mapPartTimePharmacistRow),
    });
  } catch (error) {
    return next(error);
  }
}
