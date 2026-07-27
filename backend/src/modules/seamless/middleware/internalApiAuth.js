const { readInternalApiToken } = require("../config");
const { unauthorized } = require("../errors");

function normalizeBearerToken(value) {
  const text = String(value || "").trim();
  const match = text.match(/^Bearer\s+(.+)$/i);

  return match ? match[1].trim() : "";
}

function internalApiAuth(req, res, next) {
  const internalApiToken = readInternalApiToken();

  if (!internalApiToken) {
    next();
    return;
  }

  const token = normalizeBearerToken(req.headers.authorization);

  if (token !== internalApiToken) {
    next(unauthorized("Missing or invalid internal API token."));
    return;
  }

  next();
}

module.exports = { internalApiAuth };
