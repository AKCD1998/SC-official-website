import { LOGIN_ADMIN_USERNAME } from "../config/constants.js";
import { pool } from "../db/pool.js";
import { verifyAccessToken } from "../services/auth.service.js";

export async function authRequired(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header." });
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    return res.status(401).json({ error: "Missing bearer token." });
  }

  try {
    const payload = verifyAccessToken(token);
    if (!payload?.userId || payload.role !== "admin") {
      return res.status(401).json({ error: "Invalid token payload." });
    }

    const { rows } = await pool.query(
      "SELECT branch_id FROM users WHERE id = $1 AND username = $2 AND role = 'admin'",
      [payload.userId, LOGIN_ADMIN_USERNAME]
    );
    if (!rows[0]) {
      return res.status(401).json({ error: "Invalid token payload." });
    }

    req.auth = {
      userId: payload.userId,
      role: payload.role,
      branchId: rows[0].branch_id || null,
    };

    return next();
  } catch (_error) {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

export function adminRequired(req, res, next) {
  if (!req.auth) {
    return res.status(401).json({ error: "Authentication is required." });
  }

  if (req.auth.role !== "admin") {
    return res.status(403).json({ error: "Admin role is required." });
  }

  return next();
}
