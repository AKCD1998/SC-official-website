BEGIN;

CREATE TABLE IF NOT EXISTS shopee_sales_ingest_jobs (
  job_id text PRIMARY KEY CHECK (job_id ~ '^[A-Za-z0-9._-]{1,160}$'),
  shop_code text NOT NULL CHECK (shop_code IN ('sc-drug-store', 'dr-morepen')),
  report_type text NOT NULL CHECK (report_type IN ('business-insights', 'orders')),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_filename text NOT NULL,
  observed_at timestamptz NOT NULL,
  date_from date NOT NULL,
  date_to date NOT NULL CHECK (date_to >= date_from),
  result_status text NOT NULL CHECK (result_status IN ('imported', 'unchanged')),
  source_row_count integer NOT NULL CHECK (source_row_count >= 0),
  reconciliation_status text NOT NULL,
  response_metadata jsonb NOT NULL CHECK (jsonb_typeof(response_metadata) = 'object'),
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shopee_sales_ingest_source
  ON shopee_sales_ingest_jobs (shop_code, report_type, source_sha256);
CREATE INDEX IF NOT EXISTS idx_shopee_sales_ingest_observed
  ON shopee_sales_ingest_jobs (shop_code, observed_at DESC);

COMMENT ON TABLE shopee_sales_ingest_jobs IS
  'Privacy-safe audit linking a 000-HQ download job to an immutable Shopee source import. No token, browser credential, or customer data.';

COMMIT;
