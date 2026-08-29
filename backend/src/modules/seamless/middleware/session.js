const crypto = require("node:crypto");
const { readSessionCookieMaxAgeMs, readSessionSecret } = require("../config");

const COOKIE_NAME = "sx_session";

function sign(payload) {
  const secret = readSessionSecret();
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function normalizeSessionActor(value) {
  return String(value || "").normalize("NFKC").trim();
}

// The signed payload carries the login username as an audit identity. Older role-only tokens
// remain valid but have an empty actor and therefore cannot confirm a queued AdaSmart plan.
function createSessionToken(role = "user", actor = "") {
  const expiresAt = Date.now() + readSessionCookieMaxAgeMs();
  const actorSegment = Buffer.from(normalizeSessionActor(actor), "utf8").toString("base64url");
  const payload = `${expiresAt}:${role}:${actorSegment}`;
  return `${payload}.${sign(payload)}`;
}

function verifySessionIdentity(token) {
  const text = String(token || "");
  const separatorIndex = text.lastIndexOf(".");

  if (separatorIndex === -1) {
    return null;
  }

  const payload = text.slice(0, separatorIndex);
  const providedSignature = text.slice(separatorIndex + 1);
  const expectedSignature = sign(payload);

  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (providedBuffer.length !== expectedBuffer.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    return null;
  }

  const segments = payload.split(":");
  // Tokens minted before role/actor fields remain readable. They are intentionally actor-less.
  const expiresAtText = segments[0];
  const role = segments.length < 2 ? "user" : segments[1] || "user";
  let actor = "";
  if (segments.length >= 3 && segments[2]) {
    try {
      actor = normalizeSessionActor(Buffer.from(segments[2], "base64url").toString("utf8"));
    } catch (_error) {
      return null;
    }
  }

  const expiresAt = Number(expiresAtText);
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
    return null;
  }

  return { actor, role: role === "admin" ? "admin" : "user" };
}

function verifySessionToken(token) {
  return verifySessionIdentity(token)?.role || null;
}

function cookieOptions() {
  // The client is a separate Render Static Site from this API in production, so the cookie is
  // cross-origin there — SameSite=None is required for the browser to send it at all, which in
  // turn requires Secure (browsers reject SameSite=None cookies without it). Locally, both run
  // on http://localhost, where Secure cookies are dropped by real browsers entirely — so this
  // must relax to Lax/non-Secure in dev or login would silently never persist.
  const isProduction = process.env.NODE_ENV === "production";

  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    maxAge: readSessionCookieMaxAgeMs(),
    path: "/",
  };
}

function setSessionCookie(res, role = "user", actor = "") {
  res.cookie(COOKIE_NAME, createSessionToken(role, actor), cookieOptions());
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
}

// Returns "admin" | "user" for a valid cookie, or null when there's no valid session at all —
// distinct from "no session" so callers can tell "not logged in" from "logged in as a regular
// user" without a separate boolean check.
function getSessionRole(req) {
  return getSessionIdentity(req)?.role || null;
}

function getSessionIdentity(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) {
    return null;
  }
  return verifySessionIdentity(token);
}

function hasValidSessionCookie(req) {
  return Boolean(getSessionRole(req));
}

module.exports = {
  COOKIE_NAME,
  clearSessionCookie,
  getSessionIdentity,
  getSessionRole,
  hasValidSessionCookie,
  setSessionCookie,
};
