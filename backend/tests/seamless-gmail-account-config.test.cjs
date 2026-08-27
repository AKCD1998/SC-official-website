const {
  readPharmcareGmailConfig,
  readShopeeDrMorepenGmailConfig,
  readShopeeGmailConfig,
  readShopeeGmailConfigForShop,
} = require("../src/modules/seamless/config");
const {
  createGmailAdapter,
  isGmailConfigured,
} = require("../src/modules/seamless/services/pharmcare/gmailAdapter");

const ENV_NAMES = [
  "SEAMLESS_PHARMCARE_GMAIL_MAILBOX",
  "SEAMLESS_PHARMCARE_GMAIL_AUTH_MODE",
  "SEAMLESS_PHARMCARE_GMAIL_CLIENT_ID",
  "SEAMLESS_PHARMCARE_GMAIL_CLIENT_SECRET",
  "SEAMLESS_PHARMCARE_GMAIL_REFRESH_TOKEN",
  "SEAMLESS_SHOPEE_GMAIL_QUERY",
  "SEAMLESS_SHOPEE_DRMOREPEN_GMAIL_MAILBOX",
  "SEAMLESS_SHOPEE_DRMOREPEN_GMAIL_AUTH_MODE",
  "SEAMLESS_SHOPEE_DRMOREPEN_GMAIL_CLIENT_ID",
  "SEAMLESS_SHOPEE_DRMOREPEN_GMAIL_CLIENT_SECRET",
  "SEAMLESS_SHOPEE_DRMOREPEN_GMAIL_REFRESH_TOKEN",
  "SEAMLESS_SHOPEE_DRMOREPEN_GMAIL_QUERY",
];
const originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

function setCompleteConfigs() {
  process.env.SEAMLESS_PHARMCARE_GMAIL_MAILBOX = "admin@scgroup1989.com";
  process.env.SEAMLESS_PHARMCARE_GMAIL_AUTH_MODE = "oauth_refresh_token";
  process.env.SEAMLESS_PHARMCARE_GMAIL_CLIENT_ID = "admin-client-placeholder";
  process.env.SEAMLESS_PHARMCARE_GMAIL_CLIENT_SECRET = "admin-secret-placeholder";
  process.env.SEAMLESS_PHARMCARE_GMAIL_REFRESH_TOKEN = "admin-refresh-placeholder";
  process.env.SEAMLESS_SHOPEE_GMAIL_QUERY = "from:info@mail.shopee.co.th";
  process.env.SEAMLESS_SHOPEE_DRMOREPEN_GMAIL_MAILBOX = "scgroup1989.glucooneshop@gmail.com";
  process.env.SEAMLESS_SHOPEE_DRMOREPEN_GMAIL_AUTH_MODE = "oauth_refresh_token";
  process.env.SEAMLESS_SHOPEE_DRMOREPEN_GMAIL_CLIENT_ID = "dr-client-placeholder";
  process.env.SEAMLESS_SHOPEE_DRMOREPEN_GMAIL_CLIENT_SECRET = "dr-secret-placeholder";
  process.env.SEAMLESS_SHOPEE_DRMOREPEN_GMAIL_REFRESH_TOKEN = "dr-refresh-placeholder";
  process.env.SEAMLESS_SHOPEE_DRMOREPEN_GMAIL_QUERY = "from:info@mail.shopee.co.th";
}

beforeEach(() => {
  ENV_NAMES.forEach((name) => delete process.env[name]);
});

afterAll(() => {
  ENV_NAMES.forEach((name) => {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  });
});

test("keeps the existing PharmCare and admin Shopee credential behavior unchanged", () => {
  setCompleteConfigs();

  const pharmcare = readPharmcareGmailConfig();
  const legacyShopee = readShopeeGmailConfig();

  expect(pharmcare).toMatchObject({
    clientId: "admin-client-placeholder",
    clientSecret: "admin-secret-placeholder",
    mailboxAccount: "admin@scgroup1989.com",
    refreshToken: "admin-refresh-placeholder",
  });
  expect(legacyShopee).toMatchObject({
    clientId: pharmcare.clientId,
    clientSecret: pharmcare.clientSecret,
    expectedMailbox: "admin@scgroup1989.com",
    gmailQuery: "from:info@mail.shopee.co.th",
    mailboxAccount: "admin@scgroup1989.com",
    refreshToken: pharmcare.refreshToken,
  });
});

test("pins SC Drug Store to the admin mailbox and rejects another OAuth account", async () => {
  setCompleteConfigs();
  process.env.SEAMLESS_PHARMCARE_GMAIL_MAILBOX = "other@example.com";

  const scDrugStore = readShopeeGmailConfigForShop("sc-drug-store");
  expect(scDrugStore).toMatchObject({
    expectedMailbox: "admin@scgroup1989.com",
    mailboxAccount: "admin@scgroup1989.com",
    shopCode: "sc-drug-store",
  });

  const getProfile = jest.fn(async () => ({
    data: { emailAddress: "other@example.com" },
  }));
  const list = jest.fn(async () => ({ data: { messages: [] } }));
  const adapter = createGmailAdapter(scDrugStore, {
    createGmailClient: () => ({ users: { getProfile, messages: { list } } }),
  });

  await expect(adapter.listMessagePage()).rejects.toThrow(/identity check failed/);
  expect(getProfile).toHaveBeenCalledWith({ userId: "me" });
  expect(list).not.toHaveBeenCalled();
});

test("reads DR.Morepen from a completely separate credential namespace", () => {
  setCompleteConfigs();

  const legacyShopee = readShopeeGmailConfig();
  const drMorepen = readShopeeDrMorepenGmailConfig();

  expect(drMorepen).toMatchObject({
    clientId: "dr-client-placeholder",
    clientSecret: "dr-secret-placeholder",
    expectedMailbox: "scgroup1989.glucooneshop@gmail.com",
    gmailQuery: "from:info@mail.shopee.co.th",
    mailboxAccount: "scgroup1989.glucooneshop@gmail.com",
    refreshToken: "dr-refresh-placeholder",
    shopCode: "dr-morepen",
  });
  expect(drMorepen.refreshToken).not.toBe(legacyShopee.refreshToken);
  expect(readShopeeGmailConfigForShop("dr-morepen")).toEqual(drMorepen);
});

test("pins the DR.Morepen mailbox and Shopee sender query", () => {
  setCompleteConfigs();
  process.env.SEAMLESS_SHOPEE_DRMOREPEN_GMAIL_QUERY = "from:other@example.com";
  expect(() => readShopeeDrMorepenGmailConfig()).toThrow(/QUERY must remain pinned/);

  process.env.SEAMLESS_SHOPEE_DRMOREPEN_GMAIL_QUERY = "from:info@mail.shopee.co.th";
  process.env.SEAMLESS_SHOPEE_DRMOREPEN_GMAIL_MAILBOX = "other@example.com";
  expect(() => readShopeeDrMorepenGmailConfig()).toThrow(/MAILBOX must remain pinned/);
});

test("fails safely when DR.Morepen credentials are missing instead of falling back to admin", () => {
  setCompleteConfigs();
  delete process.env.SEAMLESS_SHOPEE_DRMOREPEN_GMAIL_REFRESH_TOKEN;

  const drMorepen = readShopeeDrMorepenGmailConfig();
  expect(drMorepen.refreshToken).toBe("");
  expect(isGmailConfigured(drMorepen)).toBe(false);
  expect(drMorepen.clientId).not.toBe(readShopeeGmailConfig().clientId);
});
