const crypto = require("node:crypto");
const { readShopeeSalesIngestToken } = require("../config");
const { serviceUnavailable, unauthorized } = require("../errors");

function normalizeBearerToken(value) {
  const match = String(value || "").trim().match(/^Bearer\s+(.+)$/iu);
  return match ? match[1].trim() : "";
}

function equalSecrets(left, right) {
  const leftDigest = crypto.createHash("sha256").update(String(left)).digest();
  const rightDigest = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function shopeeSalesIngestAuth(req, res, next) {
  const configured = readShopeeSalesIngestToken();
  if (!configured) {
    next(serviceUnavailable("Shopee sales ingest is not configured."));
    return;
  }
  const provided = normalizeBearerToken(req.headers.authorization);
  if (!provided || !equalSecrets(provided, configured)) {
    next(unauthorized("Missing or invalid Shopee ingest token."));
    return;
  }
  req.appActor = "shopee-hq-agent";
  next();
}

module.exports = { equalSecrets, normalizeBearerToken, shopeeSalesIngestAuth };
