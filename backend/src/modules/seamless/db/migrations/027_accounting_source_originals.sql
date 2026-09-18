BEGIN;

CREATE TABLE IF NOT EXISTS accounting_source_originals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_code text NOT NULL CHECK (shop_code IN ('sc-drug-store', 'dr-morepen')),
  document_kind text NOT NULL CHECK (document_kind = 'statement'),
  period_type text NOT NULL CHECK (period_type IN ('weekly', 'monthly')),
  start_date date NOT NULL,
  end_date date NOT NULL CHECK (end_date >= start_date),
  source_filename text NOT NULL,
  source_sha256 text NOT NULL UNIQUE CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_file jsonb NOT NULL,
  page_count integer NOT NULL CHECK (page_count > 0),
  uploaded_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_code, document_kind, period_type, start_date, end_date)
);

CREATE INDEX IF NOT EXISTS accounting_source_originals_period
  ON accounting_source_originals (shop_code, document_kind, start_date, end_date);

COMMIT;
