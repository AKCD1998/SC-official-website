ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS scheduled_for timestamptz NOT NULL DEFAULT now();
