import bcrypt from "bcrypt";
import { randomUUID } from "crypto";
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

export async function login(req, res) {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if (!username || !password) {
    throw httpError(400, "username and password are required");
  }

  const result = await query(
    `
      SELECT
        u.id,
        u.username,
        u.password_hash,
        u.role::text AS role,
        u.location_id,
        u.is_active,
        l.code AS "branchCode",
        l.name AS "branchName"
      FROM users u
      LEFT JOIN locations l ON l.id = u.location_id
      WHERE lower(username) = lower($1)
      LIMIT 1
    `,
    [username]
  );

  const user = result.rows[0];
  if (!user) {
    throw httpError(401, "Invalid username or password");
  }

  if (!user.is_active) {
    throw httpError(403, "User account is inactive");
  }

  const isPasswordValid = await bcrypt.compare(password, user.password_hash);
  if (!isPasswordValid) {
    throw httpError(401, "Invalid username or password");
  }

  const jti = randomUUID();
  const token = jwt.sign(
    {
      id: user.id,
      role: user.role,
      location_id: user.location_id,
    },
    getJwtSecret(),
    {
      expiresIn: "8h",
      jwtid: jti,
    }
  );

  return res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      location_id: user.location_id,
      branchCode: user.branchCode || null,
      branchName: user.branchName || null,
    },
  });
}

export async function logout(req, res) {
  if (!req.user?.id) {
    throw httpError(401, "Authentication required");
  }

  const tokenJti = String(req.user?.jti || "").trim();
  if (!tokenJti) {
    throw httpError(401, "Token is missing jti");
  }

  const tokenExp = Number(req.user?.exp || 0);
  if (!Number.isFinite(tokenExp) || tokenExp <= 0) {
    throw httpError(401, "Token is missing exp");
  }

  await query(
    `
      INSERT INTO revoked_tokens (
        jti,
        user_id,
        expires_at,
        reason
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        to_timestamp($3),
        'LOGOUT'
      )
      ON CONFLICT (jti) DO NOTHING
    `,
    [tokenJti, req.user.id, tokenExp]
  );

  return res.json({ ok: true });
}
