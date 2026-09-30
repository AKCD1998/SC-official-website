-- The original CSV is retained byte-for-byte as an immutable report input.
-- This is separate from stock movements and does not assert that DEV receipts
-- are actual branch receipts.
CREATE TABLE IF NOT EXISTS ky11_bulk_source_snapshots (
  snapshot_key text PRIMARY KEY,
  period_start date NOT NULL,
  period_end date NOT NULL,
  source_filename text NOT NULL,
  source_sha256 char(64) NOT NULL,
  source_csv text NOT NULL,
  sales_row_count integer NOT NULL CHECK (sales_row_count > 0),
  lot_row_count integer NOT NULL CHECK (lot_row_count > 0),
  confirmed_paper_lot_count integer NOT NULL CHECK (confirmed_paper_lot_count >= 0),
  simulated_lot_count integer NOT NULL CHECK (simulated_lot_count >= 0),
  source_status text NOT NULL CHECK (source_status = 'DEVELOPMENT_REFERENCE'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_ky11_bulk_snapshot_period CHECK (period_start <= period_end)
);

COMMENT ON TABLE ky11_bulk_source_snapshots IS
  'Immutable historical KY11 bulk input CSVs. DEVELOPMENT_REFERENCE rows may contain simulated lot dates/capacities and must not be treated as verified stock receipts.';

CREATE OR REPLACE FUNCTION reject_ky11_bulk_snapshot_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KY11 source snapshots are immutable; insert a new version';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ky11_bulk_snapshot_immutable'
  ) THEN
    CREATE TRIGGER trg_ky11_bulk_snapshot_immutable
      BEFORE UPDATE OR DELETE ON ky11_bulk_source_snapshots
      FOR EACH ROW EXECUTE FUNCTION reject_ky11_bulk_snapshot_change();
  END IF;
END;
$$;
