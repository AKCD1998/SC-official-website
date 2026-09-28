BEGIN;
CREATE TABLE IF NOT EXISTS shopee_copy_line_evidence (
  shop_code text NOT NULL CHECK (shop_code IN ('sc-drug-store', 'dr-morepen')),
  order_number text NOT NULL CHECK (order_number ~ '^[A-Z0-9]{8,30}$'),
  paid_business_date date NOT NULL,
  business_date date NOT NULL,
  source_fact_fingerprint text NOT NULL CHECK (source_fact_fingerprint ~ '^[a-f0-9]{64}$'),
  line_financials jsonb NOT NULL CHECK (jsonb_typeof(line_financials) = 'array'),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  verified_by text NOT NULL CHECK (length(trim(verified_by)) > 0),
  verified_at timestamptz NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (shop_code, order_number)
);
CREATE INDEX IF NOT EXISTS idx_shopee_copy_line_evidence_scope
  ON shopee_copy_line_evidence (shop_code, business_date, paid_business_date) WHERE enabled;
COMMENT ON TABLE shopee_copy_line_evidence IS
  'Private source-bound product allocation evidence. Original order-level components must reconcile exactly; no inferred balancing amount or ERP master price.';
COMMIT;
