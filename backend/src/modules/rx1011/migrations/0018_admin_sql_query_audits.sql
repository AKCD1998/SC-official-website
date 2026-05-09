-- 0018_admin_sql_query_audits.sql
-- Purpose:
-- - Persist an audit trail for admin-only SQL executor requests.
-- - Capture both successful and failed attempts with execution metadata.

CREATE TABLE IF NOT EXISTS admin_sql_query_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  executed_by uuid NOT NULL REFERENCES users (id),
  statement_type text NOT NULL,
  sql_text text NOT NULL,
  succeeded boolean NOT NULL,
  result_row_count integer,
  was_truncated boolean NOT NULL DEFAULT false,
  execution_ms integer,
  statement_timeout_ms integer NOT NULL,
  row_cap integer NOT NULL,
  client_ip text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_sql_query_audits_executed_by_created_at
  ON admin_sql_query_audits (executed_by, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_sql_query_audits_created_at
  ON admin_sql_query_audits (created_at DESC);

COMMENT ON TABLE admin_sql_query_audits IS
  'Audit log for ADMIN-only read-only SQL executor requests.';

COMMENT ON COLUMN admin_sql_query_audits.sql_text IS
  'Original SQL submitted by the admin endpoint after transport decoding.';

COMMENT ON COLUMN admin_sql_query_audits.result_row_count IS
  'Number of rows returned to the caller after server-side row capping.';
