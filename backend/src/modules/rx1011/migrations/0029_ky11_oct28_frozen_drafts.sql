-- Keep the historical CSV immutable while distinguishing this documented,
-- incomplete FEFO draft from the earlier simulated development references.
ALTER TABLE ky11_bulk_source_snapshots
  DROP CONSTRAINT IF EXISTS ky11_bulk_source_snapshots_source_status_check;
ALTER TABLE ky11_bulk_source_snapshots
  ADD CONSTRAINT ky11_bulk_source_snapshots_source_status_check
  CHECK (source_status IN ('DEVELOPMENT_REFERENCE', 'DRAFT_FEFO_PARTIAL_LOT'));
ALTER TABLE ky11_bulk_source_snapshots
  ADD COLUMN IF NOT EXISTS transfer_row_count integer NOT NULL DEFAULT 0
    CHECK (transfer_row_count >= 0);
ALTER TABLE ky11_bulk_source_snapshots
  ADD COLUMN IF NOT EXISTS source_provenance jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS ky11_bulk_draft_artifacts (
  artifact_key text NOT NULL,
  snapshot_key text NOT NULL REFERENCES ky11_bulk_source_snapshots(snapshot_key),
  branch_code text,
  source_filename text NOT NULL,
  pdf_sha256 char(64) NOT NULL,
  pdf_bytes bytea NOT NULL,
  page_count integer NOT NULL CHECK (page_count > 0),
  job_count integer NOT NULL CHECK (job_count > 0),
  document_status text NOT NULL CHECK (document_status = 'DRAFT_FEFO_REVIEW'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ky11_bulk_draft_artifacts_pk PRIMARY KEY (snapshot_key, artifact_key),
  CONSTRAINT ky11_bulk_draft_artifacts_pdf_nonempty CHECK (octet_length(pdf_bytes) > 0),
  CONSTRAINT ky11_bulk_draft_artifacts_branch CHECK (branch_code IS NULL OR branch_code IN ('001','003','004','005'))
);
CREATE INDEX IF NOT EXISTS ky11_bulk_draft_artifacts_snapshot_idx
  ON ky11_bulk_draft_artifacts(snapshot_key);

COMMENT ON TABLE ky11_bulk_draft_artifacts IS
  'Exact draft PDF bytes for admin review. FEFO sale-lot allocation is inferred; this table does not attest regulatory approval.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ky11_bulk_draft_artifacts_immutable') THEN
    CREATE TRIGGER trg_ky11_bulk_draft_artifacts_immutable
      BEFORE UPDATE OR DELETE ON ky11_bulk_draft_artifacts
      FOR EACH ROW EXECUTE FUNCTION reject_ky11_bulk_snapshot_change();
  END IF;
END;
$$;
