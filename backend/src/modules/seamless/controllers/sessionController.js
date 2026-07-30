const crypto = require("node:crypto");
const { readAppBasicCredentials } = require("../config");
const { badRequest, unauthorized } = require("../errors");
const { clearSessionCookie, hasValidSessionCookie, setSessionCookie } = require("../middleware/session");

function timingSafeEqualStrings(a, b) {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));

  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufferA, bufferB);
}

async function login(req, res) {
  const { user: appBasicUser, password: appBasicPassword } = readAppBasicCredentials();
  const username = String((req.body && req.body.username) || "").trim();
  const password = String((req.body && req.body.password) || "");

  if (!username || !password) {
    throw badRequest("Username and password are required.");
  }

  if (!appBasicUser || !appBasicPassword) {
    // Login is meaningless when the app has no configured credentials at all (dev/local
    // default-open mode) — treat it as already-authenticated rather than rejecting.
    res.json({ ok: true });
    return;
  }

  if (!timingSafeEqualStrings(username, appBasicUser) || !timingSafeEqualStrings(password, appBasicPassword)) {
    throw unauthorized("Incorrect username or password.");
  }

  setSessionCookie(res);
  res.json({ ok: true });
}

async function logout(req, res) {
  clearSessionCookie(res);
  res.json({ ok: true });
}

async function getSession(req, res) {
  const { user: appBasicUser, password: appBasicPassword } = readAppBasicCredentials();
  const authRequired = Boolean(appBasicUser && appBasicPassword);

  res.json({
    authenticated: !authRequired || hasValidSessionCookie(req),
  });
}

module.exports = { getSession, login, logout };
