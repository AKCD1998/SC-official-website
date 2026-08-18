#!/usr/bin/env node
// One-time interactive setup for the PharmCare Gmail OAuth refresh-token auth mode.
// Run this ONCE, locally, logged into the browser as admin@scgroup1989.com (or whichever
// mailbox SEAMLESS_PHARMCARE_GMAIL_MAILBOX points at). It opens a consent URL, catches the
// redirect on a temporary local server, exchanges the code for tokens, and prints the
// refresh_token you paste into SEAMLESS_PHARMCARE_GMAIL_REFRESH_TOKEN on Render.
//
// This script never touches this app's database or any production system — it only talks to
// Google's OAuth endpoints and a throwaway localhost server. Requests read-only Gmail access
// (gmail.readonly) and nothing else.
//
// Usage:
//   node scripts/pharmcare-gmail-oauth-setup.cjs --client-id=... --client-secret=...
// or, if you downloaded the "OAuth client" JSON Google Cloud Console offers for Desktop app
// credentials (shape: { "installed": { "client_id": ..., "client_secret": ... } }):
//   node scripts/pharmcare-gmail-oauth-setup.cjs --client-json=/path/to/client_secret.json

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const { URL } = require("node:url");

const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const LOOPBACK_PORT = 51823; // arbitrary fixed port so the redirect URI is predictable

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { clientId, clientSecret } = loadClientCredentials(args);

  // Required lazily so this script has a clear error if googleapis isn't installed, instead of
  // failing at require-time for unrelated commands.
  const { google } = require("googleapis");

  const redirectUri = `http://127.0.0.1:${LOOPBACK_PORT}/oauth2callback`;
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline", // required to get a refresh_token back
    prompt: "consent", // forces Google to issue a refresh_token even on repeat authorizations
    scope: [GMAIL_READONLY_SCOPE],
  });

  console.log("\n1. Open this URL in a browser where you are logged in as the PharmCare mailbox owner");
  console.log("   (e.g. admin@scgroup1989.com) and approve the read-only Gmail access request:\n");
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

  console.log("\n=== Success — set these on Render (do not commit or log them anywhere else) ===\n");
  console.log("SEAMLESS_PHARMCARE_GMAIL_AUTH_MODE=oauth_refresh_token");
  console.log(`SEAMLESS_PHARMCARE_GMAIL_CLIENT_ID=${clientId}`);
  console.log(`SEAMLESS_PHARMCARE_GMAIL_CLIENT_SECRET=${clientSecret}`);
  console.log(`SEAMLESS_PHARMCARE_GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log("\nThe access_token this script also received is short-lived and not needed — only the");
  console.log("refresh_token above matters; the adapter mints fresh access tokens from it automatically.");
}

main().catch((error) => {
  console.error(`[pharmcare-gmail-oauth-setup] failed: ${error.message}`);
  process.exitCode = 1;
});
