import jwt from "jsonwebtoken";
import { query } from "../db/pool.js";
import { httpError } from "../utils/httpError.js";

function getJwtSecret() {
  const secret = String(
    process.env.RX1011_JWT_SECRET || process.env.JWT_SECRET || process.env.AUTH_JWT_SECRET || ""
  ).trim();
  if (!secret) {
    throw httpError(500, "RX1011_JWT_SECRET or JWT_SECRET is not configured");
  }
  return secret;
}

function isReadMethod(method) {
  return ["GET", "HEAD", "OPTIONS"].includes(String(method || "").toUpperCase());
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeRole(rawRole) {
  return String(rawRole || "").trim().toUpperCase();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "").trim()
  );
}

function assertOperatorWriteBlocked(req, role) {
  if (role === "OPERATOR" && !isReadMethod(req.method)) {
    throw httpError(403, "OPERATOR role is read-only");
  }
}

async function resolveUserBranch(user) {
  if (!user?.location_id) {
    throw httpError(403, "Branch-scoped access requires location_id");
  }

  const result = await query(
    `
      SELECT id, code, location_type, is_active
      FROM locations
      WHERE id = $1
      LIMIT 1
    `,
    [user.location_id]
  );

  const location = result.rows[0];
  if (!location) {
    throw httpError(403, "User location is not found");
  }
  if (location.location_type !== "BRANCH") {
    throw httpError(403, "User location is not a branch");
  }
  if (!location.is_active) {
    throw httpError(403, "User branch is inactive");
  }

  return {
    id: location.id,
    code: location.code,
  };
}

function assertFieldMatchOrEmpty(target, field, expectedCode) {
  const incoming = String(target?.[field] ?? "").trim();
  if (!incoming) return;
  if (incoming !== expectedCode) {
    throw httpError(403, `Branch access denied for field ${field}`);
  }
}

function forceFieldCode(target, field, expectedCode) {
  if (!target || typeof target !== "object") return;
  target[field] = expectedCode;
}

export async function verifyToken(req, _res, next) {
  const authHeader = String(req.headers?.authorization || "").trim();
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return next(httpError(401, "Missing or invalid Authorization header"));
  }

  let decoded;
  try {
    decoded = jwt.verify(token, getJwtSecret());
  } catch {
    return next(httpError(401, "Invalid or expired token"));
  }

  try {
    const jti = String(decoded?.jti || "").trim();
    if (!isUuid(jti)) {
      throw httpError(401, "Invalid token jti");
    }

    const revoked = await query(
      `
        SELECT 1
        FROM revoked_tokens
        WHERE jti = $1
          AND expires_at > now()
        LIMIT 1
      `,
      [jti]
    );
    if (revoked.rows[0]) {
      throw httpError(401, "Token revoked");
    }

    req.user = {
      id: decoded.id,
      role: decoded.role,
      location_id: decoded.location_id ?? null,
      jti,
      iat: decoded?.iat ?? null,
      exp: decoded?.exp ?? null,
    };
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireRole(...roles) {
  const allowed = new Set(roles.map((role) => normalizeRole(role)).filter(Boolean));

  return (req, _res, next) => {
    try {
      if (!req.user) {
        throw httpError(401, "Authentication required");
      }

      const role = normalizeRole(req.user.role);
      if (!role) {
        throw httpError(403, "User role is missing");
      }

      assertOperatorWriteBlocked(req, role);

      if (role === "ADMIN") return next();
      if (allowed.size > 0 && !allowed.has(role)) {
        throw httpError(403, "Forbidden: insufficient role");
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export function requireBranchAccess(options = {}) {
  const matchBodyFields = toArray(options.matchBodyFields);
  const forceBodyFields = toArray(options.forceBodyFields);
  const matchQueryFields = toArray(options.matchQueryFields);
  const forceQueryFields = toArray(options.forceQueryFields);

  return async (req, _res, next) => {
    try {
      if (!req.user) {
        throw httpError(401, "Authentication required");
      }

      const role = normalizeRole(req.user.role);
      if (!role) {
        throw httpError(403, "User role is missing");
      }

      assertOperatorWriteBlocked(req, role);

      if (role === "ADMIN") return next();
      if (role !== "PHARMACIST") {
        throw httpError(403, "Forbidden: branch access requires PHARMACIST or ADMIN");
      }

      const branch = await resolveUserBranch(req.user);
      req.userBranch = branch;

      for (const field of matchBodyFields) {
        assertFieldMatchOrEmpty(req.body, field, branch.code);
      }
      for (const field of forceBodyFields) {
        if (!req.body || typeof req.body !== "object") req.body = {};
        forceFieldCode(req.body, field, branch.code);
      }

      for (const field of matchQueryFields) {
        assertFieldMatchOrEmpty(req.query, field, branch.code);
      }
      for (const field of forceQueryFields) {
        if (!req.query || typeof req.query !== "object") req.query = {};
        forceFieldCode(req.query, field, branch.code);
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}
