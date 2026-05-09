import { verifyAccessToken } from "../services/auth.service.js";

export function authRequired(req, res, next) {
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
    if (!payload?.userId || !payload?.role) {
      return res.status(401).json({ error: "Invalid token payload." });
    }

    if (!["admin", "user"].includes(payload.role)) {
      return res.status(401).json({ error: "Invalid token payload." });
    }

    if (payload.role !== "admin" && !payload?.branchId) {
      return res.status(401).json({ error: "Invalid token payload." });
    }

    req.auth = {
      userId: payload.userId,
      role: payload.role,
      branchId: payload.branchId || null,
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
