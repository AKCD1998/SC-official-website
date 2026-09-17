BEGIN;
CREATE TABLE IF NOT EXISTS shopee_document_observations (
  job_id text PRIMARY KEY,
  shop_code text NOT NULL CHECK (shop_code IN ('sc-drug-store', 'dr-morepen')),
  report_type text NOT NULL CHECK (report_type = 'etax-receipt-invoice'),
  date_from date NOT NULL,
  date_to date NOT NULL CHECK (date_to = date_from),
  portal_account text NOT NULL,
  observed_at timestamptz NOT NULL,
  result_status text NOT NULL CHECK (result_status = 'no_file'),
  reason_code text NOT NULL CHECK (reason_code = 'SHOPEE_ETAX_NO_DOCUMENT_FOR_DATE'),
  source_validation jsonb NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((shop_code = 'sc-drug-store' AND portal_account = '142wuxqhgi')
    OR (shop_code = 'dr-morepen' AND portal_account = 'mu3f314od9'))
);
CREATE INDEX IF NOT EXISTS shopee_document_observations_coverage_idx
  ON shopee_document_observations (shop_code, report_type, date_from, observed_at DESC);
COMMENT ON TABLE shopee_document_observations IS
  'Append-only metadata evidence of an authenticated exact daily e-Tax search with no document. No raw report, response body, signed URL, or customer PII.';
COMMIT;
