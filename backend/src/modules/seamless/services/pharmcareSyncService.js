const pool = require("../../../../db");
const { normalizeGmailMessage } = require("./pharmcare/gmailAdapter");
const { ingestNormalizedMessage } = require("./pharmcareIngestionService");
const repository = require("../db/pharmcareRepository");

// Same advisory-lock key derivation pattern as the print queue: a stable string hashed to a
// bigint, so every instance of this service (or a manual script) computes the same key.
const ADVISORY_LOCK_KEY_STRING = "pharmcare_gmail_sync";
const DEFAULT_MAX_ATTEMPTS_PER_MESSAGE = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;

function advisoryLockKey() {
  return `hashtext('${ADVISORY_LOCK_KEY_STRING}')`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Orchestrates one full ingestion cycle against a Gmail adapter (real or mock):
//   adapter.listCandidateMessageIds() -> adapter.getMessage() -> normalizeGmailMessage()
//   -> adapter.getAttachment() per attachment -> ingestNormalizedMessage()
//
// The adapter is the only thing that talks to Gmail, and it is read-only by contract (see
// docs/13/14) — this function never sends, forwards, deletes, or labels anything. One message
// failing (a bad attachment fetch, a classifier edge case) is retried up to
// options.maxAttemptsPerMessage with a fixed backoff, then caught and reported per-message so it
// never aborts the rest of the batch; re-running against already-ingested messages is safe
// because ingestNormalizedMessage() is itself idempotent.
async function syncMessagesFromAdapter(adapter, mailboxAccount, options = {}) {
  const maxAttempts = Math.max(1, options.maxAttemptsPerMessage || DEFAULT_MAX_ATTEMPTS_PER_MESSAGE);
  const retryDelayMs = Number.isFinite(options.retryDelayMs)
    ? options.retryDelayMs
    : DEFAULT_RETRY_DELAY_MS;
  const messageIds = await adapter.listCandidateMessageIds({ after: options.after });
  const results = [];

  for (const messageId of messageIds) {
    let outcome = null;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const rawMessage = await adapter.getMessage(messageId);
        const normalized = normalizeGmailMessage(rawMessage);

        const attachments = [];
        for (const attachmentMeta of normalized.attachments) {
          // eslint-disable-next-line no-await-in-loop
          const buffer = await adapter.getAttachment(messageId, attachmentMeta.attachmentId);
          attachments.push({ ...attachmentMeta, buffer });
        }

        // eslint-disable-next-line no-await-in-loop
        outcome = await ingestNormalizedMessage({ ...normalized, attachments, mailboxAccount }, options);
        break;
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(retryDelayMs * attempt);
        }
      }
    }

    results.push(
      outcome
        ? { gmailMessageId: messageId, ...outcome }
        : {
            error: lastError ? lastError.message : "unknown error",
            gmailMessageId: messageId,
            status: "failed",
          },
    );
  }

  return results;
}

function summarizeResults(results) {
  const outcomeCounts = {};
  const errors = [];

  results.forEach((result) => {
    outcomeCounts[result.status] = (outcomeCounts[result.status] || 0) + 1;
    if (result.status === "failed") {
      errors.push({ error: result.error, gmailMessageId: result.gmailMessageId });
    }
  });

  return { errors, outcomeCounts };
}

// M2 orchestration entry point: acquires an advisory lock so concurrent instances/scripts can
// never run overlapping syncs, resumes from the stored checkpoint (newest received_at), runs the
// idempotent batch, then records run metrics and the new checkpoint. Losing the lock is recorded
// as a 'lock_busy' run (observable contention, not a silent skip) and returns without syncing.
async function runPharmcareGmailSync(adapter, mailboxAccount, options = {}) {
  const runKind = options.runKind || "incremental";
  const lockClient = await pool.connect();

  try {
    const lockResult = await lockClient.query(`SELECT pg_try_advisory_lock(${advisoryLockKey()}) AS acquired`);
    if (!lockResult.rows[0].acquired) {
      const busyRunId = await repository.markSyncRunStarted(mailboxAccount, runKind, lockClient);
      await repository.markSyncRunFinished(busyRunId, { status: "lock_busy" }, lockClient);
      return { results: [], status: "lock_busy" };
    }

    const runId = await repository.markSyncRunStarted(mailboxAccount, runKind, lockClient);
    const state = await repository.getSyncState(mailboxAccount, lockClient);
    // Backfills deliberately ignore the checkpoint (they re-scan history); incremental syncs
    // resume from it. Overlap is harmless — ingestion dedupes by gmail_message_id.
    const isBackfill = runKind === "backfill";
    const after = isBackfill || options.ignoreCheckpoint
      ? options.after
      : options.after || state.checkpoint.newestReceivedAt;

    try {
      await repository.saveSyncState(mailboxAccount, { checkpoint: state.checkpoint }, lockClient);
      const results = await syncMessagesFromAdapter(adapter, mailboxAccount, { ...options, after });

      // Compute the new checkpoint from the messages actually ingested in this run — the newest
      // receivedAt among successfully stored messages, matched back via findMessageByGmailId.
      let newestReceivedAt = after || null;
      for (const result of results) {
        if (result.status === "ingested" && result.messageId) {
          // eslint-disable-next-line no-await-in-loop
          const message = await repository.getMessageById(result.messageId);
          if (message.receivedAt && (!newestReceivedAt || message.receivedAt > newestReceivedAt)) {
            newestReceivedAt = message.receivedAt;
          }
        }
      }

      const { errors, outcomeCounts } = summarizeResults(results);
      const runCheckpoint = { ...state.checkpoint, newestReceivedAt, updatedAt: new Date().toISOString() };
      const status = outcomeCounts.failed ? "failed" : "completed";

      // Every run records the checkpoint it computed on its own run row (evidence of what it
      // scanned), but only incremental runs may advance the checkpoint in pharmcare_sync_state —
      // a backfill over old history must never move the resume point that incremental syncs use.
      await repository.markSyncRunFinished(runId, { checkpoint: runCheckpoint, errors, messageCount: results.length, outcomeCounts, status }, lockClient);
      await repository.saveSyncState(
        mailboxAccount,
        { checkpoint: isBackfill ? state.checkpoint : runCheckpoint, lastRunStatus: status },
        lockClient,
      );

      return { checkpoint: runCheckpoint, results, runId, status };
    } catch (error) {
      await repository.markSyncRunFinished(
        runId,
        {
          errors: [{ error: error.message }],
          outcomeCounts: { sync_error: 1 },
          status: "failed",
        },
        lockClient,
      );
      await repository.saveSyncState(mailboxAccount, { checkpoint: state.checkpoint, lastRunStatus: "failed" }, lockClient);
      throw error;
    }
  } finally {
    // Advisory locks are session-scoped: releasing on the same connection is what actually
    // drops the lock, so this must happen before the client returns to the pool.
    await lockClient.query(`SELECT pg_advisory_unlock(${advisoryLockKey()})`).catch(() => {});
    lockClient.release();
  }
}

module.exports = { runPharmcareGmailSync, syncMessagesFromAdapter };
