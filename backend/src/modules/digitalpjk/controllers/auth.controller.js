import { comparePassword, signAccessToken } from "../services/auth.service.js";
import { getCurrentDocumentDate } from "../services/document-date.service.js";
import {
  findUserWithBranchById,
  findUserWithBranchByUsername,
} from "../services/user-profile.service.js";

function buildAuthProfile(row) {
  const branch =
    row.branch_id && row.branch_code
      ? {
          id: row.branch_id,
          branchCode: row.branch_code,
          pharmacyNameTh: row.pharmacy_name_th,
          branchNameTh: row.branch_name_th,
          addressNo: row.address_no,
          soi: row.soi,
          district: row.district,
          province: row.province,
          postcode: row.postcode,
          phone: row.phone,
          licenseNo: row.license_no,
          locationText: row.location_text,
          operatorTitle: row.operator_title,
          operatorWorkHours: row.operator_work_hours,
        }
      : null;

  return {
    id: row.user_id,
    role: row.role,
    branch_id: row.user_branch_id || null,
    user: {
      id: row.user_id,
      username: row.username,
      role: row.role,
      displayNameTh: row.display_name_th,
      branchId: row.user_branch_id || null,
    },
    branch,
  };
}

export async function login(req, res, next) {
  try {
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required." });
    }

    const row = await findUserWithBranchByUsername(username);
    if (!row) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const isValidPassword = await comparePassword(password, row.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const token = signAccessToken({
      userId: row.user_id,
      role: row.role,
      branchId: row.user_branch_id,
    });
    const documentDate = await getCurrentDocumentDate();

    return res.status(200).json({
      token,
      documentDate,
      ...buildAuthProfile(row),
    });
  } catch (error) {
    return next(error);
  }
}

export async function getMe(req, res, next) {
  try {
    const row = await findUserWithBranchById(req.auth.userId);
    if (!row) {
      return res.status(404).json({ error: "User profile not found." });
    }

    const documentDate = await getCurrentDocumentDate();

    return res.status(200).json({
      ...buildAuthProfile(row),
      documentDate,
    });
  } catch (error) {
    return next(error);
  }
}
