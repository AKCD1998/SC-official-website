import { findBranchById, listBranches } from "../services/branches.service.js";

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

function mapBranchSummary(row) {
  return {
    id: row.id,
    branch_code: row.branch_code,
    pharmacy_name: `${row.pharmacy_name_th || ""} ${row.branch_name_th || ""}`.trim(),
    pharmacy_name_th: row.pharmacy_name_th,
    branch_name_th: row.branch_name_th,
  };
}

function mapBranchProfile(row) {
  return {
    id: row.id,
    branch_code: row.branch_code,
    pharmacy_name_th: row.pharmacy_name_th,
    branch_name_th: row.branch_name_th,
    address_no: row.address_no,
    soi: row.soi,
    district: row.district,
    province: row.province,
    postcode: row.postcode,
    phone: row.phone,
    license_no: row.license_no,
    location_text: row.location_text,
    operator_display_name_th: row.operator_display_name_th,
    operator_title: row.operator_title,
    operator_work_hours: row.operator_work_hours,
  };
}

export async function listBranchesHandler(req, res, next) {
  try {
    if (req.auth.role === "admin") {
      const rows = await listBranches();
      return res.status(200).json({
        branches: rows.map(mapBranchSummary),
      });
    }

    if (!req.auth.branchId) {
      return res.status(403).json({ error: "Forbidden." });
    }

    const branchRow = await findBranchById(req.auth.branchId);
    if (!branchRow) {
      return res.status(404).json({ error: "Branch not found." });
    }

    return res.status(200).json({
      branches: [mapBranchSummary(branchRow)],
    });
  } catch (error) {
    return next(error);
  }
}

export async function getBranchByIdHandler(req, res, next) {
  try {
    const requestedBranchId = String(req.params.id || "");
    if (!isUuid(requestedBranchId)) {
      return res.status(400).json({ error: "Invalid branch id." });
    }

    if (req.auth.role !== "admin" && req.auth.branchId !== requestedBranchId) {
      return res.status(403).json({ error: "Forbidden." });
    }

    const branchRow = await findBranchById(requestedBranchId);
    if (!branchRow) {
      return res.status(404).json({ error: "Branch not found." });
    }

    return res.status(200).json({
      branch: mapBranchProfile(branchRow),
    });
  } catch (error) {
    return next(error);
  }
}
