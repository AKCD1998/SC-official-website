const fs = require("node:fs");
const path = require("node:path");
const {
  parseShopCode,
  renewShopeeGmailWatch,
} = require("../scripts/shopee-gmail-watch.cjs");

function configured(overrides = {}) {
  return {
    authMode: "oauth_refresh_token",
    clientId: "client-id",
    clientSecret: "client-secret",
    mailboxAccount: "admin@scgroup1989.com",
    pubsubTopicName: "projects/example/topics/gmail-admin-updates",
    refreshToken: "refresh-token",
    ...overrides,
  };
}

test("requires an explicit supported Shopee shop", () => {
  expect(parseShopCode(["--shop-code=sc-drug-store"])).toBe("sc-drug-store");
  expect(parseShopCode(["--shop-code=dr-morepen"])).toBe("dr-morepen");
  expect(() => parseShopCode([])).toThrow("กรุณาเลือกร้าน Shopee");
});

test("renews a Gmail watch against the configured topic", async () => {
  const watchMailbox = jest.fn(async () => ({
    expiration: String(Date.parse("2026-09-08T00:00:00.000Z")),
    historyId: "12345",
  }));

  const result = await renewShopeeGmailWatch("sc-drug-store", {
    adapter: { watchMailbox },
    config: configured(),
  });

  expect(watchMailbox).toHaveBeenCalledWith("projects/example/topics/gmail-admin-updates");
  expect(result).toMatchObject({
    expiresAt: "2026-09-08T00:00:00.000Z",
    historyId: "12345",
    shopCode: "sc-drug-store",
  });
});

test("fails closed when OAuth or the topic is missing", async () => {
  await expect(renewShopeeGmailWatch("sc-drug-store", {
    config: configured({ refreshToken: "" }),
  })).rejects.toThrow("OAuth is not configured");

  await expect(renewShopeeGmailWatch("sc-drug-store", {
    config: configured({ pubsubTopicName: "" }),
  })).rejects.toThrow("topic is not configured");
});

test("daily renewal workflow keeps each mailbox behind its own enable flag and secrets", () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, "..", "..", ".github", "workflows", "shopee-gmail-watch-renew.yml"),
    "utf8",
  );

  expect(workflow).toContain("SHOPEE_SC_GMAIL_PUSH_ENABLED");
  expect(workflow).toContain("SHOPEE_DRMOREPEN_GMAIL_PUSH_ENABLED");
  expect(workflow).toContain("SEAMLESS_SHOPEE_SC_GMAIL_PUBSUB_TOPIC");
  expect(workflow).toContain("SEAMLESS_SHOPEE_DRMOREPEN_GMAIL_PUBSUB_TOPIC");
  expect(workflow).toContain("--shop-code=sc-drug-store");
  expect(workflow).toContain("--shop-code=dr-morepen");
});
