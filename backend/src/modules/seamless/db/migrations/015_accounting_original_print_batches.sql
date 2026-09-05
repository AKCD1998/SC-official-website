BEGIN;
CREATE TABLE IF NOT EXISTS accounting_print_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint text NOT NULL UNIQUE,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'preparing'
    CHECK (status IN ('preparing','review','queued','printing','paused','completed','cancelled')),
  manifest jsonb NOT NULL,
  agent_host text NOT NULL,
  printer_name text NOT NULL,
  approved_digest text,
  created_by text NOT NULL DEFAULT '',
  approved_by text,
  approved_at timestamptz,
  pause_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS accounting_print_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES accounting_print_batches(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  document jsonb NOT NULL,
  source_file jsonb NOT NULL,
  preview_file jsonb,
  page_count integer CHECK (page_count > 0),
  warnings jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','preparing','ready','printing','submitted','completed','failed','uncertain')),
  attempt integer NOT NULL DEFAULT 0,
  claim_token uuid,
  lease_until timestamptz,
  spooler_job_id integer,
  error_message text,
  history jsonb NOT NULL DEFAULT '[]',
  completed_at timestamptz,
  UNIQUE (batch_id, sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS accounting_print_single_claim
  ON accounting_print_items ((true)) WHERE status IN ('preparing','printing','submitted');
CREATE INDEX IF NOT EXISTS accounting_print_batch_status ON accounting_print_batches(status, created_at);
CREATE TABLE IF NOT EXISTS accounting_print_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_sequence bigserial UNIQUE,
  batch_id uuid NOT NULL REFERENCES accounting_print_batches(id),
  event_key text NOT NULL,
  message text NOT NULL,
  retry_key uuid NOT NULL DEFAULT gen_random_uuid(),
  attempts integer NOT NULL DEFAULT 0,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, event_key)
);
COMMIT;
