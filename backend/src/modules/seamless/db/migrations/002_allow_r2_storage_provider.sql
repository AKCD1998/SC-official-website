ALTER TABLE generated_files
  DROP CONSTRAINT generated_files_storage_provider_check;

ALTER TABLE generated_files
  ADD CONSTRAINT generated_files_storage_provider_check
  CHECK (storage_provider IN ('local', 'r2', 'google_drive', 'external', 'unknown'));
