BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key text PRIMARY KEY,
  setting_value text NOT NULL,
  description text,
  is_secret boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE app_settings IS 'Non-secret application and legacy GAS configuration values used for migration traceability.';
COMMENT ON COLUMN app_settings.is_secret IS 'Secrets must not be committed or seeded; this flag exists for runtime-managed values only.';

DROP TRIGGER IF EXISTS trg_app_settings_updated_at ON app_settings;
CREATE TRIGGER trg_app_settings_updated_at
BEFORE UPDATE ON app_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS branch_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_code text NOT NULL UNIQUE,
  branch_code char(3) NOT NULL CHECK (branch_code ~ '^[0-9]{3}$'),
  label text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE branch_mappings IS 'Reference mapping from Seamless/DMIS HCODE or service code values to three-digit branch codes.';
COMMENT ON COLUMN branch_mappings.source_code IS 'Normalized source code such as D1180 from the original GAS SXBranchCodeMap.';
COMMENT ON COLUMN branch_mappings.branch_code IS 'Three-digit branch code used in output filenames and history grouping.';

CREATE INDEX IF NOT EXISTS idx_branch_mappings_branch_code ON branch_mappings (branch_code);
CREATE INDEX IF NOT EXISTS idx_branch_mappings_active ON branch_mappings (active);

DROP TRIGGER IF EXISTS trg_branch_mappings_updated_at ON branch_mappings;
CREATE TRIGGER trg_branch_mappings_updated_at
BEFORE UPDATE ON branch_mappings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS processing_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  formatter_mode text CHECK (formatter_mode IS NULL OR formatter_mode IN ('individual', 'summary')),
  batch_mode text NOT NULL DEFAULT 'unknown' CHECK (batch_mode IN ('single', 'multi', 'legacy', 'unknown')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'completed_with_warnings', 'partially_failed', 'failed', 'cancelled', 'imported')),
  file_count integer NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  success_count integer NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  created_by text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE processing_batches IS 'One user submission batch; groups multiple uploaded workbooks and their shared preview output.';
COMMENT ON COLUMN processing_batches.formatter_mode IS 'Requested formatter mode selected by the UI panel.';
COMMENT ON COLUMN processing_batches.batch_mode IS 'single or multi mirrors the GAS preview filename batch label; legacy is for migrated rows.';

CREATE INDEX IF NOT EXISTS idx_processing_batches_started_at ON processing_batches (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_processing_batches_status ON processing_batches (status);
CREATE INDEX IF NOT EXISTS idx_processing_batches_formatter_mode ON processing_batches (formatter_mode);

DROP TRIGGER IF EXISTS trg_processing_batches_updated_at ON processing_batches;
CREATE TRIGGER trg_processing_batches_updated_at
BEFORE UPDATE ON processing_batches
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS processing_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_registry_id text UNIQUE,
  report_date_key char(8) NOT NULL CHECK (report_date_key ~ '^[0-9]{8}$'),
  report_date date,
  report_type text NOT NULL CHECK (report_type IN ('individual', 'summary')),
  filename text NOT NULL,
  legacy_drive_file_id text,
  legacy_drive_file_url text,
  uploaded_at timestamptz,
  uploaded_by text,
  printed boolean NOT NULL DEFAULT false,
  printed_at timestamptz,
  printed_by text,
  source_upload_name text,
  notes text,
  last_action text,
  legacy_branch_codes text,
  legacy_registry_spreadsheet_id text,
  legacy_registry_sheet_name text,
  legacy_row_number integer CHECK (legacy_row_number IS NULL OR legacy_row_number > 0),
  migration_source text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE processing_records IS 'Primary PERN replacement for the GAS ProcessingRegistry sheet.';
COMMENT ON COLUMN processing_records.legacy_registry_id IS 'Exact original GAS registry id when it is not used as the PostgreSQL UUID primary key.';
COMMENT ON COLUMN processing_records.report_date_key IS 'Original registry reportDate key in YYYYMMDD format for parity with GAS filtering.';
COMMENT ON COLUMN processing_records.report_date IS 'Optional typed date derived from report_date_key for easier PostgreSQL querying.';
COMMENT ON COLUMN processing_records.legacy_drive_file_id IS 'Original Google Drive file or spreadsheet id from the registry driveFileId field.';
COMMENT ON COLUMN processing_records.legacy_branch_codes IS 'Original comma-separated branchCodes string preserved exactly enough for migration comparison.';
COMMENT ON COLUMN processing_records.metadata IS 'Additional migrated metadata that does not yet deserve first-class columns.';

CREATE INDEX IF NOT EXISTS idx_processing_records_report_type_date ON processing_records (report_type, report_date_key);
CREATE INDEX IF NOT EXISTS idx_processing_records_printed ON processing_records (printed);
CREATE INDEX IF NOT EXISTS idx_processing_records_uploaded_at ON processing_records (uploaded_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_processing_records_filename ON processing_records (filename);
CREATE INDEX IF NOT EXISTS idx_processing_records_legacy_drive_file_id ON processing_records (legacy_drive_file_id);
CREATE INDEX IF NOT EXISTS idx_processing_records_source_upload_name ON processing_records (source_upload_name);
CREATE INDEX IF NOT EXISTS idx_processing_records_created_at ON processing_records (created_at DESC);

DROP TRIGGER IF EXISTS trg_processing_records_updated_at ON processing_records;
CREATE TRIGGER trg_processing_records_updated_at
BEFORE UPDATE ON processing_records
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS processing_record_branch_codes (
  processing_record_id uuid NOT NULL REFERENCES processing_records(id) ON DELETE CASCADE,
  branch_code char(3) NOT NULL CHECK (branch_code ~ '^[0-9]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (processing_record_id, branch_code)
);

COMMENT ON TABLE processing_record_branch_codes IS 'Normalized branch codes extracted from the legacy processing_records.legacy_branch_codes value or preview sheet names.';

CREATE INDEX IF NOT EXISTS idx_processing_record_branch_codes_branch_code ON processing_record_branch_codes (branch_code);

CREATE TABLE IF NOT EXISTS workbook_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid REFERENCES processing_batches(id) ON DELETE SET NULL,
  processing_record_id uuid REFERENCES processing_records(id) ON DELETE SET NULL,
  original_filename text NOT NULL,
  mime_type text,
  file_size_bytes bigint CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
  requested_variant text CHECK (requested_variant IS NULL OR requested_variant IN ('individual', 'summary')),
  detected_variant text CHECK (detected_variant IS NULL OR detected_variant IN ('individual', 'summary')),
  effective_variant text CHECK (effective_variant IS NULL OR effective_variant IN ('individual', 'summary')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'skipped', 'imported')),
  error_message text,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  deleted_columns jsonb NOT NULL DEFAULT '[]'::jsonb,
  highlight_count integer NOT NULL DEFAULT 0 CHECK (highlight_count >= 0),
  transform_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE workbook_uploads IS 'Metadata for uploaded source XLSX files and their per-file processing outcome.';
COMMENT ON COLUMN workbook_uploads.deleted_columns IS 'Array of deleted-column reports matching the GAS response shape.';
COMMENT ON COLUMN workbook_uploads.transform_summary IS 'Additional workbook transform details such as worksheetName, parsed dates, branch source, or library-specific diagnostics.';

CREATE INDEX IF NOT EXISTS idx_workbook_uploads_batch_id ON workbook_uploads (batch_id);
CREATE INDEX IF NOT EXISTS idx_workbook_uploads_processing_record_id ON workbook_uploads (processing_record_id);
CREATE INDEX IF NOT EXISTS idx_workbook_uploads_status ON workbook_uploads (status);
CREATE INDEX IF NOT EXISTS idx_workbook_uploads_created_at ON workbook_uploads (created_at DESC);

DROP TRIGGER IF EXISTS trg_workbook_uploads_updated_at ON workbook_uploads;
CREATE TRIGGER trg_workbook_uploads_updated_at
BEFORE UPDATE ON workbook_uploads
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS generated_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  processing_record_id uuid REFERENCES processing_records(id) ON DELETE SET NULL,
  batch_id uuid REFERENCES processing_batches(id) ON DELETE SET NULL,
  upload_id uuid REFERENCES workbook_uploads(id) ON DELETE SET NULL,
  file_kind text NOT NULL CHECK (file_kind IN ('source_upload', 'processed_xlsx', 'preview_workbook', 'legacy_drive_file')),
  filename text NOT NULL,
  mime_type text,
  storage_provider text NOT NULL DEFAULT 'local' CHECK (storage_provider IN ('local', 'google_drive', 'external', 'unknown')),
  storage_path text,
  download_url text,
  view_url text,
  file_size_bytes bigint CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
  checksum_sha256 char(64) CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-fA-F]{64}$'),
  legacy_drive_file_id text,
  legacy_drive_file_url text,
  legacy_google_mime_type text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE generated_files IS 'Tracks source uploads, processed XLSX outputs, preview workbooks, and migrated legacy Drive file references.';
COMMENT ON COLUMN generated_files.file_kind IS 'source_upload, processed_xlsx, preview_workbook, or legacy_drive_file.';
COMMENT ON COLUMN generated_files.storage_path IS 'Local filesystem path or object key for generated files; not used for legacy Drive-only rows.';
COMMENT ON COLUMN generated_files.expires_at IS 'Optional retention cutoff for temporary files; migrated historical files should usually leave this null.';

CREATE INDEX IF NOT EXISTS idx_generated_files_processing_record_id ON generated_files (processing_record_id);
CREATE INDEX IF NOT EXISTS idx_generated_files_batch_id ON generated_files (batch_id);
CREATE INDEX IF NOT EXISTS idx_generated_files_upload_id ON generated_files (upload_id);
CREATE INDEX IF NOT EXISTS idx_generated_files_file_kind ON generated_files (file_kind);
CREATE INDEX IF NOT EXISTS idx_generated_files_legacy_drive_file_id ON generated_files (legacy_drive_file_id);
CREATE INDEX IF NOT EXISTS idx_generated_files_created_at ON generated_files (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generated_files_expires_at ON generated_files (expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_generated_files_updated_at ON generated_files;
CREATE TRIGGER trg_generated_files_updated_at
BEFORE UPDATE ON generated_files
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS preview_sheets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  preview_file_id uuid NOT NULL REFERENCES generated_files(id) ON DELETE CASCADE,
  upload_id uuid REFERENCES workbook_uploads(id) ON DELETE SET NULL,
  processing_record_id uuid REFERENCES processing_records(id) ON DELETE SET NULL,
  sheet_name text NOT NULL,
  sheet_order integer NOT NULL CHECK (sheet_order > 0),
  legacy_sheet_id text,
  legacy_spreadsheet_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (preview_file_id, sheet_name),
  UNIQUE (preview_file_id, sheet_order)
);

COMMENT ON TABLE preview_sheets IS 'Sheet-level metadata for preview workbooks, preserving GAS batch preview behavior.';
COMMENT ON COLUMN preview_sheets.legacy_sheet_id IS 'Original Google Sheets sheetId when preview sheets are migrated from Drive.';

CREATE INDEX IF NOT EXISTS idx_preview_sheets_preview_file_id ON preview_sheets (preview_file_id);
CREATE INDEX IF NOT EXISTS idx_preview_sheets_processing_record_id ON preview_sheets (processing_record_id);
CREATE INDEX IF NOT EXISTS idx_preview_sheets_upload_id ON preview_sheets (upload_id);

DROP TRIGGER IF EXISTS trg_preview_sheets_updated_at ON preview_sheets;
CREATE TRIGGER trg_preview_sheets_updated_at
BEFORE UPDATE ON preview_sheets
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS operation_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL DEFAULT 'app',
  level text NOT NULL DEFAULT 'INFO' CHECK (level IN ('DEBUG', 'INFO', 'WARN', 'ERROR')),
  action text NOT NULL,
  message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor text,
  processing_record_id uuid REFERENCES processing_records(id) ON DELETE SET NULL,
  batch_id uuid REFERENCES processing_batches(id) ON DELETE SET NULL,
  upload_id uuid REFERENCES workbook_uploads(id) ON DELETE SET NULL,
  generated_file_id uuid REFERENCES generated_files(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE operation_logs IS 'Persistent audit and diagnostic events replacing the non-persistent Apps Script console logs.';
COMMENT ON COLUMN operation_logs.metadata IS 'Structured details for actions such as upload processed, printed status changed, or migration row skipped.';

CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at ON operation_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operation_logs_action ON operation_logs (action);
CREATE INDEX IF NOT EXISTS idx_operation_logs_level ON operation_logs (level);
CREATE INDEX IF NOT EXISTS idx_operation_logs_processing_record_id ON operation_logs (processing_record_id);
CREATE INDEX IF NOT EXISTS idx_operation_logs_upload_id ON operation_logs (upload_id);

CREATE TABLE IF NOT EXISTS migration_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name text NOT NULL,
  source_type text NOT NULL DEFAULT 'csv',
  status text NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'completed', 'completed_with_warnings', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  records_read integer NOT NULL DEFAULT 0 CHECK (records_read >= 0),
  records_created integer NOT NULL DEFAULT 0 CHECK (records_created >= 0),
  records_updated integer NOT NULL DEFAULT 0 CHECK (records_updated >= 0),
  records_skipped integer NOT NULL DEFAULT 0 CHECK (records_skipped >= 0),
  records_failed integer NOT NULL DEFAULT 0 CHECK (records_failed >= 0),
  error_summary text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE migration_logs IS 'Run-level summaries for imports from GAS registry CSV exports and related legacy data sources.';
COMMENT ON COLUMN migration_logs.source_name IS 'Human-readable source, for example ProcessingRegistry.csv.';

CREATE INDEX IF NOT EXISTS idx_migration_logs_started_at ON migration_logs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_migration_logs_status ON migration_logs (status);
CREATE INDEX IF NOT EXISTS idx_migration_logs_source_name ON migration_logs (source_name);

DROP TRIGGER IF EXISTS trg_migration_logs_updated_at ON migration_logs;
CREATE TRIGGER trg_migration_logs_updated_at
BEFORE UPDATE ON migration_logs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
