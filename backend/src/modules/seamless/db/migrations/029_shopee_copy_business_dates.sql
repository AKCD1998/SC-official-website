BEGIN;

-- Private, case-specific evidence belongs in the database, not public source
-- control. This migration creates the ledger only; it seeds no business data.
CREATE TABLE IF NOT EXISTS shopee_copy_business_dates (
  shop_code text NOT NULL CHECK (shop_code IN ('sc-drug-store', 'dr-morepen')),
  order_number text NOT NULL CHECK (order_number ~ '^[A-Z0-9]{8,30}$'),
  paid_business_date date NOT NULL,
  business_date date NOT NULL CHECK (business_date <> paid_business_date),
  source_fact_fingerprint text NOT NULL CHECK (source_fact_fingerprint ~ '^[a-f0-9]{64}$'),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  verified_by text NOT NULL CHECK (length(trim(verified_by)) > 0),
  verified_at timestamptz NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (shop_code, order_number)
);
CREATE INDEX IF NOT EXISTS idx_shopee_copy_business_dates_scope
  ON shopee_copy_business_dates (shop_code, business_date, paid_business_date) WHERE enabled;
COMMENT ON TABLE shopee_copy_business_dates IS
  'Evidence-backed daily copy-table cohort corrections. Does not assert a confirmation timestamp or rewrite Order All facts. Source drift blocks copying on both affected dates.';

COMMIT;
