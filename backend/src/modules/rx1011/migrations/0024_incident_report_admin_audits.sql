BEGIN;

ALTER TABLE incident_reports
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by_admin_user_id uuid REFERENCES users (id),
  ADD COLUMN IF NOT EXISTS delete_reason_text text;

CREATE INDEX IF NOT EXISTS idx_incident_reports_deleted_at
  ON incident_reports (deleted_at);

CREATE TABLE IF NOT EXISTS incident_report_admin_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_report_id uuid NOT NULL REFERENCES incident_reports (id) ON DELETE CASCADE,
  action_type varchar(20) NOT NULL,
  previous_snapshot jsonb NOT NULL,
  next_snapshot jsonb,
  reason_text text NOT NULL,
  changed_by uuid NOT NULL REFERENCES users (id),
  changed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_incident_report_admin_audits_action_type
    CHECK (action_type IN ('UPDATE', 'DELETE'))
);

CREATE INDEX IF NOT EXISTS idx_incident_report_admin_audits_incident_changed_at
  ON incident_report_admin_audits (incident_report_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_incident_report_admin_audits_changed_by
  ON incident_report_admin_audits (changed_by, changed_at DESC);

COMMENT ON COLUMN incident_reports.deleted_at IS
  'Soft-delete timestamp for admin-hidden incident reports; records remain available for stock movement traceability.';

COMMENT ON COLUMN incident_reports.delete_reason_text IS
  'Admin-provided reason for soft-deleting the incident report.';

COMMENT ON TABLE incident_report_admin_audits IS
  'Audit trail for admin edits and soft-deletes of incident report metadata.';

COMMIT;
