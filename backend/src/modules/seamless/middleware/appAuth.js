const crypto = require("node:crypto");
const { readAppAdminBasicCredentials, readAppBasicCredentials, readInternalApiToken } = require("../config");
const { unauthorized } = require("../errors");
const { getSessionRole } = require("./session");

// Unlike ClaspSCxSeamless's own appAuth (which wraps the ENTIRE standalone app), this shared
// backend serves many public, unrelated features. This middleware must only be mounted on the
// specific seamless-app routers that need it
// (/api/app/*, /api/files/*, /api/bootstrap, /api/workbooks/*) — never globally — so the rest
// of sc-official-website stays reachable with no login prompt.

function normalizeBearerToken(value) {
  const text = String(value || "").trim();
  const match = text.match(/^Bearer\s+(.+)$/i);

  return match ? match[1].trim() : "";
}

function parseBasicCredentials(value) {
  const text = String(value || "").trim();
  const match = text.match(/^Basic\s+(.+)$/i);

  if (!match) {
    return null;
  }

  let decoded;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch (error) {
    return null;
  }

  const separatorIndex = decoded.indexOf(":");

  if (separatorIndex === -1) {
    return null;
  }

  return {
    username: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1),
  };
}

function timingSafeEqualStrings(a, b) {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));

  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufferA, bufferB);
}

function appAuth(req, res, next) {
  const { user: appBasicUser, password: appBasicPassword } = readAppBasicCredentials();

  if (!appBasicUser || !appBasicPassword) {
    // Default-open (no credentials configured at all, e.g. local dev) — everyone gets admin so
    // nothing is hidden while poking around locally.
    req.appRole = "admin";
    next();
    return;
  }

  const sessionRole = getSessionRole(req);
  if (sessionRole) {
    req.appRole = sessionRole;
    next();
    return;
  }

  const internalApiToken = readInternalApiToken();
  const bearerToken = normalizeBearerToken(req.headers.authorization);

  if (internalApiToken && bearerToken && timingSafeEqualStrings(bearerToken, internalApiToken)) {
    // Internal server-to-server callers (print-agent, cron scripts) are trusted, not
    // role-restricted — they don't hit the admin-gated UI routes anyway.
    req.appRole = "admin";
    next();
    return;
  }

  const basicCredentials = parseBasicCredentials(req.headers.authorization);
  const { user: appAdminUser, password: appAdminPassword } = readAppAdminBasicCredentials();

  if (
    basicCredentials &&
    appAdminUser &&
    appAdminPassword &&
    timingSafeEqualStrings(basicCredentials.username, appAdminUser) &&
    timingSafeEqualStrings(basicCredentials.password, appAdminPassword)
  ) {
    req.appRole = "admin";
    next();
    return;
  }

  if (
    basicCredentials &&
    timingSafeEqualStrings(basicCredentials.username, appBasicUser) &&
    timingSafeEqualStrings(basicCredentials.password, appBasicPassword)
  ) {
    req.appRole = "user";
    next();
    return;
  }

  res.set("WWW-Authenticate", 'Basic realm="ClaspSCxSeamless"');
  next(unauthorized("Authentication required."));
}

module.exports = { appAuth };
