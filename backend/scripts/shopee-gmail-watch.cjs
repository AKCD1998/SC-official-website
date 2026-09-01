#!/usr/bin/env node

"use strict";

require("dotenv").config({ quiet: true });

const {
  readShopeeGmailConfigForShop,
} = require("../src/modules/seamless/config");
const {
  createGmailAdapter,
  isGmailConfigured,
} = require("../src/modules/seamless/services/pharmcare/gmailAdapter");
const {
  requireShopeeShopCode,
} = require("../src/modules/seamless/services/shopeeShops");

function parseShopCode(argv) {
  const argument = argv.find((value) => value.startsWith("--shop-code="));
  return requireShopeeShopCode(argument?.slice("--shop-code=".length));
}

async function renewShopeeGmailWatch(shopCode, dependencies = {}) {
  const config = dependencies.config || readShopeeGmailConfigForShop(shopCode);
  if (!isGmailConfigured(config)) {
    throw new Error(`Gmail OAuth is not configured for ${shopCode}.`);
  }
  if (!config.pubsubTopicName) {
    throw new Error(`Gmail Pub/Sub topic is not configured for ${shopCode}.`);
  }

  const adapter = dependencies.adapter || createGmailAdapter(config);
  const result = await adapter.watchMailbox(config.pubsubTopicName);
  return {
    expiresAt: new Date(Number(result.expiration)).toISOString(),
    historyId: result.historyId,
    mailboxAccount: config.mailboxAccount,
    shopCode,
    topicName: config.pubsubTopicName,
  };
}

async function runCli() {
  try {
    const shopCode = parseShopCode(process.argv.slice(2));
    const result = await renewShopeeGmailWatch(shopCode);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      name: error?.name || "Error",
      type: "shopee_gmail_watch_failed",
    }));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  parseShopCode,
  renewShopeeGmailWatch,
};
