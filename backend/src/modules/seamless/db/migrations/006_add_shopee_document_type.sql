ALTER TABLE processing_batches
  DROP CONSTRAINT IF EXISTS processing_batches_formatter_mode_check;

ALTER TABLE processing_batches
  ADD CONSTRAINT processing_batches_formatter_mode_check
  CHECK (formatter_mode IS NULL OR formatter_mode IN ('individual', 'summary', 'shopee'));

ALTER TABLE processing_records
  DROP CONSTRAINT IF EXISTS processing_records_report_type_check;

ALTER TABLE processing_records
  ADD CONSTRAINT processing_records_report_type_check
  CHECK (report_type IN ('individual', 'summary', 'shopee'));

ALTER TABLE workbook_uploads
  DROP CONSTRAINT IF EXISTS workbook_uploads_requested_variant_check;

ALTER TABLE workbook_uploads
  ADD CONSTRAINT workbook_uploads_requested_variant_check
  CHECK (requested_variant IS NULL OR requested_variant IN ('individual', 'summary', 'shopee'));

ALTER TABLE workbook_uploads
  DROP CONSTRAINT IF EXISTS workbook_uploads_detected_variant_check;

ALTER TABLE workbook_uploads
  ADD CONSTRAINT workbook_uploads_detected_variant_check
  CHECK (detected_variant IS NULL OR detected_variant IN ('individual', 'summary', 'shopee'));

ALTER TABLE workbook_uploads
  DROP CONSTRAINT IF EXISTS workbook_uploads_effective_variant_check;

ALTER TABLE workbook_uploads
  ADD CONSTRAINT workbook_uploads_effective_variant_check
  CHECK (effective_variant IS NULL OR effective_variant IN ('individual', 'summary', 'shopee'));
