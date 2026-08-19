const crypto = require("node:crypto");
const { readAppAdminBasicCredentials, readAppBasicCredentials } = require("../config");
const { badRequest, unauthorized } = require("../errors");
const { clearSessionCookie, getSessionRole, setSessionCookie } = require("../middleware/session");

function timingSafeEqualStrings(a, b) {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));

  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufferA, bufferB);
}

function matchesAnyUsername(candidate, usernames) {
  return usernames.some((username) => timingSafeEqualStrings(candidate, username));
}

async function login(req, res) {
  const { users: appBasicUsers, password: appBasicPassword } = readAppBasicCredentials();
  const { user: appAdminUser, password: appAdminPassword } = readAppAdminBasicCredentials();
  const username = String((req.body && req.body.username) || "").trim();
  const password = String((req.body && req.body.password) || "");

  if (!username || !password) {
    throw badRequest("Username and password are required.");
  }

  if (!appBasicUsers.length || !appBasicPassword) {
    // Login is meaningless when the app has no configured credentials at all (dev/local
    // default-open mode) — treat it as already-authenticated rather than rejecting.
    res.json({ ok: true, role: "admin" });
    return;
  }

  // Check the admin pair first — if it happens to be configured identically to the regular
  // pair (misconfiguration), admin still wins so nobody is silently under-privileged.
  if (
    appAdminUser &&
    appAdminPassword &&
    timingSafeEqualStrings(username, appAdminUser) &&
    timingSafeEqualStrings(password, appAdminPassword)
  ) {
    setSessionCookie(res, "admin");
    res.json({ ok: true, role: "admin" });
    return;
  }

  if (!matchesAnyUsername(username, appBasicUsers) || !timingSafeEqualStrings(password, appBasicPassword)) {
    throw unauthorized("Incorrect username or password.");
  }

  setSessionCookie(res, "user");
  res.json({ ok: true, role: "user" });
}

async function logout(req, res) {
  clearSessionCookie(res);
  res.json({ ok: true });
}

async function getSession(req, res) {
  const { users: appBasicUsers, password: appBasicPassword } = readAppBasicCredentials();
  const authRequired = Boolean(appBasicUsers.length && appBasicPassword);

  if (!authRequired) {
    res.json({ authenticated: true, role: "admin" });
    return;
  }

  const role = getSessionRole(req);

  res.json({
    authenticated: Boolean(role),
    role: role || undefined,
  });
}

module.exports = { getSession, login, logout };
