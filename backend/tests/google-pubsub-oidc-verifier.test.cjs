const {
  readBearerToken,
  verifyGooglePubsubOidcRequest,
} = require("../src/modules/seamless/services/googlePubsubOidcVerifier");

const config = {
  audience: "https://sc-official-website.onrender.com/api/shopee-webhooks/gmail",
  serviceAccountEmail: "pubsub-push-shopee@example-project.iam.gserviceaccount.com",
};

function requestWithAuthorization(value) {
  return { get: jest.fn(() => value) };
}

function verifierWithPayload(payload) {
  return {
    verifyIdToken: jest.fn(async () => ({ getPayload: () => payload })),
  };
}

test("extracts only a single bearer token", () => {
  expect(readBearerToken("Bearer signed-token")).toBe("signed-token");
  expect(readBearerToken("bearer signed-token")).toBe("signed-token");
  expect(readBearerToken("Basic abc")).toBe("");
  expect(readBearerToken("Bearer token with-spaces")).toBe("");
});

test("verifies the signature and exact configured audience and service account", async () => {
  const oauth2Client = verifierWithPayload({
    email: config.serviceAccountEmail,
    email_verified: true,
  });

  const payload = await verifyGooglePubsubOidcRequest(
    requestWithAuthorization("Bearer signed-token"),
    config,
    { oauth2Client },
  );

  expect(payload.email).toBe(config.serviceAccountEmail);
  expect(oauth2Client.verifyIdToken).toHaveBeenCalledWith({
    audience: config.audience,
    idToken: "signed-token",
  });
});

test("fails closed when push authentication config is incomplete", async () => {
  await expect(verifyGooglePubsubOidcRequest(
    requestWithAuthorization("Bearer signed-token"),
    { audience: "", serviceAccountEmail: "" },
  )).rejects.toMatchObject({ statusCode: 503 });
});

test("rejects a missing or invalid Google ID token without exposing verifier details", async () => {
  await expect(verifyGooglePubsubOidcRequest(
    requestWithAuthorization(""),
    config,
  )).rejects.toMatchObject({ statusCode: 401 });

  const oauth2Client = {
    verifyIdToken: jest.fn(async () => { throw new Error("certificate detail"); }),
  };
  await expect(verifyGooglePubsubOidcRequest(
    requestWithAuthorization("Bearer invalid"),
    config,
    { oauth2Client },
  )).rejects.toMatchObject({
    message: "Invalid Pub/Sub OIDC bearer token.",
    statusCode: 401,
  });
});

test.each([
  [{ email: "another@example-project.iam.gserviceaccount.com", email_verified: true }],
  [{ email: config.serviceAccountEmail, email_verified: false }],
])("rejects an unexpected or unverified service-account identity", async (payload) => {
  await expect(verifyGooglePubsubOidcRequest(
    requestWithAuthorization("Bearer signed-token"),
    config,
    { oauth2Client: verifierWithPayload(payload) },
  )).rejects.toMatchObject({ statusCode: 401 });
});
