ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS email_notified_at timestamptz;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS email_notify_error text;
