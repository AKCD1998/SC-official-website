#!/usr/bin/env node
// PharmCare Gmail operations CLI (Milestone 2). Read-only against Gmail in every mode — the
// adapter is gmail.readonly-scoped and this script never calls any write operation.
//
// Modes:
//   dry-run      fetch ONE real message, classify it, print the full evidence, and write NOTHING
//                (neither DB nor Gmail). Optional --message-id=<id>; otherwise the newest
//                candidate message is used.
//   ingest-one   dry-run first, then actually ingest that one message (DB write only). Run it
//                twice to prove the second run reports already_ingested.
//   sync         incremental run: advisory lock + stored checkpoint + bounded retry + metrics.
//   backfill     full scan from --since=YYYY-MM-DD (default: mailbox start); same locking and
//                idempotency as sync, so re-running is always safe.
//   status       show the sync checkpoint and recent sync runs.
//   watch        start/renew Gmail push notifications to SEAMLESS_PHARMCARE_GMAIL_PUBSUB_TOPIC.
//                Expires in <= 7 days — call this again periodically (e.g. a daily Render Cron
//                Job) before it expires, or notifications silently stop with no error anywhere.
//
// Requires the SEAMLESS_PHARMCARE_GMAIL_* env vars (see src/modules/seamless/config.js).
// Usage: node scripts/pharmcare-gmail.cjs <mode> [--message-id=...] [--since=YYYY-MM-DD]

"use strict";

require("dotenv").config();

const path = require("node:path");
const {
  createGmailAdapter,
  isGmailConfigured,
  normalizeGmailMessage,
} = require("../src/modules/seamless/services/pharmcare/gmailAdapter");
const { classifyPharmcareEmail, CLASSIFIER_VERSION } = require("../src/modules/seamless/services/pharmcare/classifier");
const { readPharmcareGmailConfig, readPharmcareSenderAllowlist } = require("../src/modules/seamless/config");

function parseArgs(argv) {
  const args = { mode: argv[0] || "", messageId: "", since: "" };
  for (const arg of argv.slice(1)) {
    const match = arg.match(/^--([a-z-]+)=(.*)$/i);
    if (match && match[1] === "message-id") args.messageId = match[2];
    if (match && match[1] === "since") args.since = match[2];
  }
  return args;
}

function usage() {
  console.log("Usage: node scripts/pharmcare-gmail.cjs <dry-run|ingest-one|sync|backfill|status|watch> [--message-id=ID] [--since=YYYY-MM-DD]");
}

async function fetchOneMessage(adapter, messageId) {
  const id = messageId || (await adapter.listCandidateMessageIds({ maxResults: 1 }))[0];
  if (!id) {
    throw new Error("No candidate messages found in the mailbox for the configured query.");
  }
  const rawMessage = await adapter.getMessage(id);
  const normalized = normalizeGmailMessage(rawMessage);

  const attachments = [];
  for (const attachmentMeta of normalized.attachments) {
    // eslint-disable-next-line no-await-in-loop
    const buffer = await adapter.getAttachment(id, attachmentMeta.attachmentId);
    attachments.push({ ...attachmentMeta, buffer });
  }

  return { attachments, id, normalized };
}

async function dryRun(adapter, mailboxAccount, messageId) {
  const { attachments, id, normalized } = await fetchOneMessage(adapter, messageId);
  const senderAllowlist = readPharmcareSenderAllowlist() || undefined;
  const classification = classifyPharmcareEmail(
    { ...normalized, attachments, mailboxAccount },
    { senderAllowlist },
  );

  // Evidence view only — attachment buffers are intentionally not printed (financial documents).
  console.log(JSON.stringify({
    classifierVersion: CLASSIFIER_VERSION,
    classification,
    gmailMessageId: id,
    mailboxAccount,
    normalized: {
      receivedAt: normalized.receivedAt,
      routeHint: undefined,
      rawSubject: normalized.rawSubject,
      visibleFrom: normalized.visibleFrom,
    },
    attachmentDigests: attachments.map((a) => ({
      attachmentId: a.attachmentId,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
    })),
  }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const modes = ["dry-run", "ingest-one", "sync", "backfill", "status", "watch"];
  if (!modes.includes(args.mode)) {
    usage();
    process.exitCode = 1;
    return;
  }

  const config = readPharmcareGmailConfig();
  if (args.mode !== "status" && !isGmailConfigured(config)) {
    console.error("PharmCare Gmail is not configured. Set SEAMLESS_PHARMCARE_GMAIL_AUTH_MODE and its credential env vars.");
    process.exitCode = 1;
    return;
  }

  // Status is DB-only; everything else needs the Gmail adapter.
  if (args.mode === "status") {
    const repository = require("../src/modules/seamless/db/pharmcareRepository");
    const state = await repository.getSyncState(config.mailboxAccount);
    const runs = await repository.listRecentSyncRuns(config.mailboxAccount, 10);
    console.log(JSON.stringify({ mailboxAccount: config.mailboxAccount, recentRuns: runs, state }, null, 2));
    const pool = require("../db");
    await pool.end();
    return;
  }

  const adapter = createGmailAdapter(config);

  if (args.mode === "watch") {
    if (!config.pubsubTopicName) {
      console.error("SEAMLESS_PHARMCARE_GMAIL_PUBSUB_TOPIC is not set.");
      process.exitCode = 1;
      return;
    }
    const result = await adapter.watchMailbox(config.pubsubTopicName);
    console.log(JSON.stringify({
      expiresAt: new Date(Number(result.expiration)).toISOString(),
      historyId: result.historyId,
      topicName: config.pubsubTopicName,
    }, null, 2));
    return;
  }

  if (args.mode === "dry-run") {
    await dryRun(adapter, config.mailboxAccount, args.messageId);
    return;
  }

  if (args.mode === "ingest-one") {
    // Lazy require: pulls in the DB pool + storage only when actually ingesting.
    const { ingestNormalizedMessage } = require("../src/modules/seamless/services/pharmcareIngestionService");
    const { attachments, id, normalized } = await fetchOneMessage(adapter, args.messageId);
    const outcome = await ingestNormalizedMessage({ ...normalized, attachments, mailboxAccount: config.mailboxAccount });
    console.log(JSON.stringify(outcome, null, 2));
    const pool = require("../db");
    await pool.end();
    return;
  }

  // A malformed --since must fail loudly: silently treating it as "no filter" would scan the
  // entire mailbox, which is exactly what --since exists to prevent.
  let sinceDate;
  if (args.since) {
    sinceDate = new Date(args.since);
    if (Number.isNaN(sinceDate.getTime())) {
      console.error(`Invalid --since value: '${args.since}' (expected YYYY-MM-DD). Refusing to run an unbounded scan.`);
      process.exitCode = 1;
      return;
    }
  }

  const { runPharmcareGmailSync } = require("../src/modules/seamless/services/pharmcareSyncService");
  const startedAt = Date.now();
  const outcome = await runPharmcareGmailSync(adapter, config.mailboxAccount, {
    after: sinceDate,
    ignoreCheckpoint: args.mode === "backfill",
    onProgress(event) {
      const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (event.type === "listed") {
        console.error(`[${elapsedSeconds}s] Found ${event.total} candidate message(s) to process.`);
      } else if (event.type === "start") {
        console.error(`[${elapsedSeconds}s] (${event.index}/${event.total}) fetching ${event.gmailMessageId} ...`);
      } else if (event.type === "done") {
        console.error(`[${elapsedSeconds}s] (${event.index}/${event.total}) ${event.gmailMessageId} -> ${event.status}`);
      }
    },
    runKind: args.mode === "backfill" ? "backfill" : "incremental",
  });

  const { outcomeCounts } = (() => {
    const counts = {};
    (outcome.results || []).forEach((r) => {
      counts[r.status] = (counts[r.status] || 0) + 1;
    });
    return { outcomeCounts: counts };
  })();
  console.log(JSON.stringify({ checkpoint: outcome.checkpoint, outcomeCounts, runId: outcome.runId, status: outcome.status }, null, 2));

  const pool = require("../db");
  await pool.end();
}

main().catch((error) => {
  console.error(`[pharmcare-gmail] ${path.basename(process.argv[1])} failed:`, error.message);
  process.exitCode = 1;
});
