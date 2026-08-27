const {
  GMAIL_READONLY_SCOPE,
  loadClientCredentials,
  loadSetupIdentity,
  verifyExpectedMailbox,
} = require("../scripts/pharmcare-gmail-oauth-setup.cjs");
const fs = require("node:fs");
const path = require("node:path");

test("OAuth setup is limited to gmail.readonly", () => {
  expect(GMAIL_READONLY_SCOPE).toBe("https://www.googleapis.com/auth/gmail.readonly");
  const script = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "pharmcare-gmail-oauth-setup.cjs"),
    "utf8",
  );
  expect(script).not.toMatch(/console\.log\([^\n]*tokens\.access_token/u);
});

test("accepts the exact GlucoOne mailbox with the DR.Morepen env namespace", () => {
  expect(loadSetupIdentity({
    "env-prefix": "SEAMLESS_SHOPEE_DRMOREPEN_GMAIL",
    "expected-email": "scgroup1989.glucooneshop@gmail.com",
  })).toEqual({
    envPrefix: "SEAMLESS_SHOPEE_DRMOREPEN_GMAIL",
    expectedEmail: "scgroup1989.glucooneshop@gmail.com",
  });
});

test("loads an installed/Desktop OAuth client through --client-json", () => {
  const readFile = jest.spyOn(fs, "readFileSync").mockReturnValueOnce(JSON.stringify({
    installed: {
      client_id: "desktop-client-id-placeholder",
      client_secret: "desktop-client-secret-placeholder",
    },
  }));

  expect(loadClientCredentials({ "client-json": "private-client.json" })).toEqual({
    clientId: "desktop-client-id-placeholder",
    clientSecret: "desktop-client-secret-placeholder",
  });
  expect(readFile).toHaveBeenCalledWith("private-client.json", "utf8");
  readFile.mockRestore();
});

test("rejects putting a GlucoOne authorization under the PharmCare namespace", () => {
  expect(() => loadSetupIdentity({
    "env-prefix": "SEAMLESS_PHARMCARE_GMAIL",
    "expected-email": "scgroup1989.glucooneshop@gmail.com",
  })).toThrow(/does not match the selected env namespace/);
});

test("passes an exact Gmail profile match and rejects any other account", async () => {
  const matching = {
    users: {
      getProfile: jest.fn(async () => ({
        data: { emailAddress: "scgroup1989.glucooneshop@gmail.com" },
      })),
    },
  };
  await expect(verifyExpectedMailbox(
    matching,
    "scgroup1989.glucooneshop@gmail.com",
  )).resolves.toBe("scgroup1989.glucooneshop@gmail.com");

  const mismatched = {
    users: {
      getProfile: jest.fn(async () => ({ data: { emailAddress: "other@example.com" } })),
    },
  };
  await expect(verifyExpectedMailbox(
    mismatched,
    "scgroup1989.glucooneshop@gmail.com",
  )).rejects.toThrow(/does not exactly match/);
});
