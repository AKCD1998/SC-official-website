#!/usr/bin/env node
// Debug helper: re-fetches ONE message live from Gmail (read-only, no DB writes) and prints its
// bodyText so a forwarded-block parsing failure can be diagnosed. The stored DB row does not
// keep bodyText, so this is the only way to see what the parser actually saw.
//
// Usage: node scripts/pharmcare-debug-gmail-message.cjs <gmail_message_id>

"use strict";

require("dotenv").config();

const { createGmailAdapter } = require("../src/modules/seamless/services/pharmcare/gmailAdapter");
const { normalizeGmailMessage } = require("../src/modules/seamless/services/pharmcare/gmailAdapter");
const { parseForwardedBlock } = require("../src/modules/seamless/services/pharmcare/emailNormalizer");
const { readPharmcareGmailConfig } = require("../src/modules/seamless/config");

async function main() {
  const gmailMessageId = process.argv[2];
  if (!gmailMessageId) {
    console.error("Usage: node scripts/pharmcare-debug-gmail-message.cjs <gmail_message_id>");
    process.exitCode = 1;
    return;
  }

  const config = readPharmcareGmailConfig();
  const adapter = createGmailAdapter(config);
  const rawMessage = await adapter.getMessage(gmailMessageId);
  const normalized = normalizeGmailMessage(rawMessage);

  console.log("=== rawSubject ===");
  console.log(normalized.rawSubject);
  console.log("\n=== visibleFrom ===");
  console.log(normalized.visibleFrom);
  console.log("\n=== bodyText (first 3000 chars) ===");
  console.log((normalized.bodyText || "(empty — no text/plain part found)").slice(0, 3000));
  console.log("\n=== parseForwardedBlock result ===");
  console.log(JSON.stringify(parseForwardedBlock(normalized.bodyText), null, 2));
  console.log("\n=== payload.parts mimeTypes (for reference) ===");
  console.log((rawMessage.payload?.parts || []).map((p) => p.mimeType));
}

main().catch((error) => {
  console.error("[pharmcare-debug-gmail-message] failed:", error.message);
  process.exitCode = 1;
});
