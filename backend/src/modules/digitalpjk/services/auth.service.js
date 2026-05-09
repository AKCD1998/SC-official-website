import "dotenv/config";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const SALT_ROUNDS = 10;
const TOKEN_ISSUER = "digitalpjk";
const TOKEN_AUDIENCE = "digitalpjk";

function getJwtSecret() {
  if (!process.env.DIGITALPJK_JWT_SECRET) {
    throw new Error("DIGITALPJK_JWT_SECRET is required.");
  }

  return process.env.DIGITALPJK_JWT_SECRET;
}

export async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function comparePassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash);
}

export function signAccessToken(payload, options = {}) {
  return jwt.sign(payload, getJwtSecret(), {
    expiresIn: process.env.DIGITALPJK_JWT_EXPIRES_IN || "1h",
    ...options,
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
  });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, getJwtSecret(), {
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
  });
}
