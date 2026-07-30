const crypto = require("node:crypto");
const { readSessionCookieMaxAgeMs, readSessionSecret } = require("../config");

const COOKIE_NAME = "sx_session";

function sign(payload) {
  const secret = readSessionSecret();
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

// Session token is a plain `<expiresAtMs>.<hmac>` — there is only one shared login (no
// per-user identity to carry), so a stateless signed expiry is enough; no session table needed.
function createSessionToken() {
  const expiresAt = Date.now() + readSessionCookieMaxAgeMs();
  const payload = String(expiresAt);
  return `${payload}.${sign(payload)}`;
}

function verifySessionToken(token) {
  const text = String(token || "");
  const separatorIndex = text.lastIndexOf(".");

  if (separatorIndex === -1) {
    return false;
  }

  const payload = text.slice(0, separatorIndex);
  const providedSignature = text.slice(separatorIndex + 1);
  const expectedSignature = sign(payload);

  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    return false;
  }

  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && Date.now() < expiresAt;
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

function setSessionCookie(res) {
  res.cookie(COOKIE_NAME, createSessionToken(), cookieOptions());
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
}

function hasValidSessionCookie(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  return Boolean(token) && verifySessionToken(token);
}

module.exports = {
  COOKIE_NAME,
  clearSessionCookie,
  hasValidSessionCookie,
  setSessionCookie,
};
