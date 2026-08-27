#!/usr/bin/env node
// One-time interactive setup for a project-scoped Gmail OAuth refresh-token auth mode.
// The expected mailbox and destination env namespace are mandatory so a refresh token cannot
// accidentally be copied into another feature's credential set.
//
// This script never touches this app's database or any production system — it only talks to
// Google's OAuth endpoints and a throwaway localhost server. Requests read-only Gmail access
// (gmail.readonly) and nothing else.
//
// Usage:
//   node scripts/pharmcare-gmail-oauth-setup.cjs --client-id=... --client-secret=... \
//     --expected-email=admin@scgroup1989.com --env-prefix=SEAMLESS_PHARMCARE_GMAIL \
//     --token-output=/private/path/pharmcare-oauth.env
// or, if you downloaded the "OAuth client" JSON Google Cloud Console offers for Desktop app
// credentials (shape: { "installed": { "client_id": ..., "client_secret": ... } }):
//   node scripts/pharmcare-gmail-oauth-setup.cjs --client-json=/path/to/client_secret.json \
//     --expected-email=scgroup1989.glucooneshop@gmail.com \
//     --env-prefix=SEAMLESS_SHOPEE_DRMOREPEN_GMAIL \
//     --token-output=/private/path/shopee-oauth.env

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const LOOPBACK_PORT = 51823; // arbitrary fixed port so the redirect URI is predictable
const ENV_PREFIX_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const PINNED_NAMESPACE_MAILBOXES = Object.freeze({
  SEAMLESS_PHARMCARE_GMAIL: "admin@scgroup1989.com",
  SEAMLESS_SHOPEE_DRMOREPEN_GMAIL: "scgroup1989.glucooneshop@gmail.com",
});

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const match = arg.match(/^--([a-z-]+)=(.*)$/i);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

function loadClientCredentials(args) {
  if (args["client-json"]) {
    const raw = JSON.parse(fs.readFileSync(args["client-json"], "utf8"));
    const creds = raw.installed || raw.web || raw;
    if (!creds.client_id || !creds.client_secret) {
      throw new Error("client-json file is missing client_id/client_secret.");
    }
    return { clientId: creds.client_id, clientSecret: creds.client_secret };
  }

  if (args["client-id"] && args["client-secret"]) {
    return { clientId: args["client-id"], clientSecret: args["client-secret"] };
  }

  throw new Error(
    "Pass either --client-json=<path to downloaded OAuth client JSON> or both --client-id=... --client-secret=...",
  );
}

function loadSetupIdentity(args) {
  const expectedEmail = String(args["expected-email"] || "").trim();
  const envPrefix = String(args["env-prefix"] || "").trim();
  if (!expectedEmail) {
    throw new Error("--expected-email=<mailbox> is required.");
  }
  if (!ENV_PREFIX_PATTERN.test(envPrefix)) {
    throw new Error("--env-prefix must be an uppercase environment-variable prefix.");
  }

  const pinnedMailbox = PINNED_NAMESPACE_MAILBOXES[envPrefix];
  if (pinnedMailbox && expectedEmail !== pinnedMailbox) {
    throw new Error("The expected mailbox does not match the selected env namespace.");
  }
  return { envPrefix, expectedEmail };
}

async function verifyExpectedMailbox(gmailClient, expectedEmail) {
  const { data } = await gmailClient.users.getProfile({ userId: "me" });
  if (data?.emailAddress !== expectedEmail) {
    throw new Error("Authorized Gmail account does not exactly match --expected-email.");
  }
  return data.emailAddress;
}

function formatPrivateEnvironment({ envPrefix, expectedEmail, refreshToken }) {
  const lines = [
    `${envPrefix}_MAILBOX=${expectedEmail}`,
    `${envPrefix}_AUTH_MODE=oauth_refresh_token`,
    `${envPrefix}_CLIENT_ID=<client_id from the same private client JSON>`,
    `${envPrefix}_CLIENT_SECRET=<client_secret from the same private client JSON>`,
    `${envPrefix}_REFRESH_TOKEN=${refreshToken}`,
  ];
  if (envPrefix === "SEAMLESS_SHOPEE_DRMOREPEN_GMAIL") {
    lines.push(`${envPrefix}_QUERY=from:info@mail.shopee.co.th`);
  }
  return `${lines.join("\n")}\n`;
}

function deliverPrivateEnvironment({ args, envPrefix, expectedEmail, refreshToken }, deps = {}) {
  const log = deps.log || console.log;
  const writeFileSync = deps.writeFileSync || fs.writeFileSync;
  const privateEnvironment = formatPrivateEnvironment({
    envPrefix,
    expectedEmail,
    refreshToken,
  });

  if (args["show-refresh-token"] === "true") {
    log("\n=== Mailbox verified — copy these only into your private environment ===\n");
    privateEnvironment.trimEnd().split("\n").forEach((line) => log(line));
    return { mode: "terminal" };
  }

  const tokenOutput = String(args["token-output"] || "").trim();
  if (!tokenOutput) {
    throw new Error(
      "Pass --token-output=<new private file> (recommended), or explicitly opt in with --show-refresh-token=true.",
    );
  }
  const resolvedPath = path.resolve(tokenOutput);
  writeFileSync(resolvedPath, privateEnvironment, { encoding: "utf8", flag: "wx", mode: 0o600 });
  log(`\nMailbox verified. Private environment written once to: ${resolvedPath}`);
  log("The refresh token was not printed to the terminal.");
  return { mode: "file", path: resolvedPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { clientId, clientSecret } = loadClientCredentials(args);
  const { envPrefix, expectedEmail } = loadSetupIdentity(args);
  if (!args["token-output"] && args["show-refresh-token"] !== "true") {
    throw new Error(
      "Pass --token-output=<new private file> (recommended), or explicitly opt in with --show-refresh-token=true.",
    );
  }

  // Required lazily so this script has a clear error if googleapis isn't installed, instead of
  // failing at require-time for unrelated commands.
  const { google } = require("googleapis");

  const redirectUri = `http://127.0.0.1:${LOOPBACK_PORT}/oauth2callback`;
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline", // required to get a refresh_token back
    include_granted_scopes: false,
    login_hint: expectedEmail,
    prompt: "consent", // forces Google to issue a refresh_token even on repeat authorizations
    scope: [GMAIL_READONLY_SCOPE],
  });

  console.log("\n1. Open this URL in a browser and choose only the expected mailbox:");
  console.log(`   ${expectedEmail}\n`);
  console.log(`   ${authUrl}\n`);
  console.log(`2. Waiting for the browser redirect back to ${redirectUri} ...\n`);

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url, `http://127.0.0.1:${LOOPBACK_PORT}`);
      if (requestUrl.pathname !== "/oauth2callback") {
        res.writeHead(404).end();
        return;
      }

      const error = requestUrl.searchParams.get("error");
      const receivedCode = requestUrl.searchParams.get("code");

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        error
          ? `<h1>Authorization failed</h1><p>${error}</p><p>You can close this tab.</p>`
          : "<h1>Authorization received</h1><p>You can close this tab and go back to the terminal.</p>",
      );
      server.close();

      if (error) {
        reject(new Error(`Google returned an error: ${error}`));
      } else if (!receivedCode) {
        reject(new Error("No authorization code in the redirect."));
      } else {
        resolve(receivedCode);
      }
    });

    server.listen(LOOPBACK_PORT, "127.0.0.1");
  });

  const { tokens } = await oauth2Client.getToken(code);

  // Verify the account before displaying or persisting any long-lived credential. The access
  // token is used only for this read-only profile check and is never printed.
  oauth2Client.setCredentials(tokens);
  const gmailClient = google.gmail({ auth: oauth2Client, version: "v1" });
  await verifyExpectedMailbox(gmailClient, expectedEmail);

  if (!tokens.refresh_token) {
    console.error(
      "\nGoogle did not return a refresh_token. This usually means this client/account combination\n" +
        "was already authorized before without --prompt=consent being honored. Go to\n" +
        "https://myaccount.google.com/permissions , remove access for this app's name, then re-run\n" +
        "this script.",
    );
    process.exitCode = 1;
    return;
  }

  deliverPrivateEnvironment({
    args,
    envPrefix,
    expectedEmail,
    refreshToken: tokens.refresh_token,
  });
  console.log("\nThe access_token this script also received is short-lived and was not printed.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[pharmcare-gmail-oauth-setup] failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  deliverPrivateEnvironment,
  formatPrivateEnvironment,
  GMAIL_READONLY_SCOPE,
  loadClientCredentials,
  loadSetupIdentity,
  parseArgs,
  verifyExpectedMailbox,
};
