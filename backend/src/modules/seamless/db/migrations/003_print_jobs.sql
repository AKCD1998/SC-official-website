CREATE TABLE IF NOT EXISTS print_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  processing_record_id uuid NOT NULL REFERENCES processing_records(id),
  generated_file_id uuid REFERENCES generated_files(id),
  attempt_no integer NOT NULL DEFAULT 1,
  is_reprint boolean NOT NULL DEFAULT false,
  reprint_reason text,
  requested_by text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','downloading','sent_to_spooler','printing','completed','failed')),
  agent_host text,
  printer_name text,
  spooler_job_id integer,
  error_message text,
  document_uploaded_at timestamptz,
  queued_at timestamptz NOT NULL DEFAULT now(),
  sent_to_spooler_at timestamptz,
  completed_at timestamptz,
  line_notified_at timestamptz,
  line_notify_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_print_jobs_record ON print_jobs (processing_record_id);
CREATE INDEX idx_print_jobs_status ON print_jobs (status);
CREATE INDEX idx_print_jobs_queued_at ON print_jobs (queued_at DESC);

DROP TRIGGER IF EXISTS trg_print_jobs_updated_at ON print_jobs;
CREATE TRIGGER trg_print_jobs_updated_at
BEFORE UPDATE ON print_jobs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
