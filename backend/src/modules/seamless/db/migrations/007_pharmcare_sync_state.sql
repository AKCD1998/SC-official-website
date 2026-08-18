BEGIN;

-- PharmCare Gmail sync orchestration state (Milestone 2). Separated from the ingestion tables in
-- 006 so sync bookkeeping never mixes with document evidence. See docs/14-pharmcare-sonnet-
-- implementation-plan.md section 8 item 1 (cursor/checkpoint, advisory lock, bounded retry,
-- error metrics). Advisory locks themselves need no table (pg_try_advisory_lock is used); this
-- migration stores the resume checkpoint and per-run metrics.

CREATE TABLE IF NOT EXISTS pharmcare_sync_state (
  mailbox_account text PRIMARY KEY,
  -- Checkpoint for incremental syncs: the newest message received_at successfully processed,
  -- plus the last Gmail historyId seen. Re-ingesting overlapping messages is always safe
  -- (ingestion is idempotent by gmail_message_id); the checkpoint only narrows the query.
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_run_started_at timestamptz,
  last_run_finished_at timestamptz,
  last_run_status text CHECK (last_run_status IS NULL OR last_run_status IN ('completed', 'failed', 'lock_busy')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE pharmcare_sync_state IS 'One row per PharmCare automation mailbox holding the incremental-sync checkpoint (newest received_at + last historyId) and last-run bookkeeping.';

DROP TRIGGER IF EXISTS trg_pharmcare_sync_state_updated_at ON pharmcare_sync_state;
CREATE TRIGGER trg_pharmcare_sync_state_updated_at
BEFORE UPDATE ON pharmcare_sync_state
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS pharmcare_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_account text NOT NULL,
  run_kind text NOT NULL CHECK (run_kind IN ('incremental', 'backfill', 'single_message')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'lock_busy')),
  message_count int NOT NULL DEFAULT 0,
  -- Status-name -> count and per-message error summaries; the error metrics for M2.
  outcome_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE pharmcare_sync_runs IS 'One row per Gmail sync attempt (including ones that lost the advisory lock, so lock contention itself is observable).';

CREATE INDEX IF NOT EXISTS idx_pharmcare_sync_runs_mailbox_started_at
  ON pharmcare_sync_runs (mailbox_account, started_at DESC);

COMMIT;
