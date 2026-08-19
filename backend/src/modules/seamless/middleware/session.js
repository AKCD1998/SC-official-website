const crypto = require("node:crypto");
const { readSessionCookieMaxAgeMs, readSessionSecret } = require("../config");

const COOKIE_NAME = "sx_session";

function sign(payload) {
  const secret = readSessionSecret();
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

// Session token is a plain `<expiresAtMs>:<role>.<hmac>` — there is no per-user identity to
// carry (still one shared login per role), but a role now rides along stateless-signed so
// appAuth doesn't need to re-derive it from the original Basic credentials on every request.
function createSessionToken(role = "user") {
  const expiresAt = Date.now() + readSessionCookieMaxAgeMs();
  const payload = `${expiresAt}:${role}`;
  return `${payload}.${sign(payload)}`;
}

// Returns the session's role ("admin" | "user") when the token is valid, or null when it's
// missing/tampered/expired. Callers that only care about validity can check truthiness.
function verifySessionToken(token) {
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

  const separatorPos = payload.indexOf(":");
  // Tokens minted before the role field existed have no ":" — treat those as "user" so
  // sessions issued right before a deploy don't get silently logged out.
  const expiresAtText = separatorPos === -1 ? payload : payload.slice(0, separatorPos);
  const role = separatorPos === -1 ? "user" : payload.slice(separatorPos + 1) || "user";

  const expiresAt = Number(expiresAtText);
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
    return null;
  }

  return role === "admin" ? "admin" : "user";
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

function setSessionCookie(res, role = "user") {
  res.cookie(COOKIE_NAME, createSessionToken(role), cookieOptions());
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
}

// Returns "admin" | "user" for a valid cookie, or null when there's no valid session at all —
// distinct from "no session" so callers can tell "not logged in" from "logged in as a regular
// user" without a separate boolean check.
function getSessionRole(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) {
    return null;
  }
  return verifySessionToken(token);
}

function hasValidSessionCookie(req) {
  return Boolean(getSessionRole(req));
}

module.exports = {
  COOKIE_NAME,
  clearSessionCookie,
  getSessionRole,
  hasValidSessionCookie,
  setSessionCookie,
};
