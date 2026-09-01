const { OAuth2Client } = require("google-auth-library");
const { serviceUnavailable, unauthorized } = require("../errors");

let defaultClient;

function getDefaultClient() {
  if (!defaultClient) defaultClient = new OAuth2Client();
  return defaultClient;
}

function readBearerToken(authorization) {
  const match = String(authorization || "").match(/^Bearer\s+([^\s]+)$/i);
  return match ? match[1] : "";
}

async function verifyGooglePubsubOidcRequest(req, config, dependencies = {}) {
  const audience = String(config?.audience || "").trim();
  const expectedEmail = String(config?.serviceAccountEmail || "").trim().toLowerCase();
  if (!audience || !expectedEmail) {
    throw serviceUnavailable("Shopee Gmail push authentication is not configured.");
  }

  const idToken = readBearerToken(req.get("authorization"));
  if (!idToken) {
    throw unauthorized("Missing Pub/Sub OIDC bearer token.");
  }

  let ticket;
  try {
    const client = dependencies.oauth2Client || getDefaultClient();
    ticket = await client.verifyIdToken({ audience, idToken });
  } catch (error) {
    throw unauthorized("Invalid Pub/Sub OIDC bearer token.");
  }

  const payload = ticket.getPayload();
  const actualEmail = String(payload?.email || "").trim().toLowerCase();
  if (payload?.email_verified !== true || actualEmail !== expectedEmail) {
    throw unauthorized("Pub/Sub OIDC service account is not authorized.");
  }

  return payload;
}

module.exports = {
  readBearerToken,
  verifyGooglePubsubOidcRequest,
};
