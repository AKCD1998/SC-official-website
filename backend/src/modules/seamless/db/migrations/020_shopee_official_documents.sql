BEGIN;

ALTER TABLE shopee_sales_ingest_jobs
  DROP CONSTRAINT IF EXISTS shopee_sales_ingest_jobs_report_type_check;
ALTER TABLE shopee_sales_ingest_jobs
  ADD CONSTRAINT shopee_sales_ingest_jobs_report_type_check CHECK (report_type IN (
    'business-insights',
    'orders',
    'financial-statement',
    'seller-balance',
    'income-transferred',
    'income-pending',
    'return-refund-cancel'
  ));

CREATE TABLE IF NOT EXISTS shopee_official_document_sources (
  shop_code text NOT NULL CHECK (shop_code IN ('sc-drug-store', 'dr-morepen')),
  source_sha256 text NOT NULL UNIQUE CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  report_type text NOT NULL CHECK (report_type IN (
    'financial-statement',
    'seller-balance',
    'income-transferred',
    'income-pending',
    'return-refund-cancel'
  )),
  source_filename text NOT NULL,
  observed_at timestamptz NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL CHECK (end_date >= start_date),
  source_row_count integer NOT NULL CHECK (source_row_count >= 0),
  control jsonb NOT NULL CHECK (jsonb_typeof(control) = 'object'),
  imported_by text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_code, source_sha256)
);

CREATE INDEX IF NOT EXISTS idx_shopee_official_documents_period
  ON shopee_official_document_sources
  (shop_code, report_type, start_date, end_date, observed_at DESC);

CREATE TABLE IF NOT EXISTS shopee_financial_statement_facts (
  shop_code text NOT NULL,
  source_sha256 text NOT NULL,
  transferred_total numeric(14,2) NOT NULL,
  page_count integer NOT NULL CHECK (page_count >= 1),
  PRIMARY KEY (shop_code, source_sha256),
  FOREIGN KEY (shop_code, source_sha256)
    REFERENCES shopee_official_document_sources(shop_code, source_sha256)
);

CREATE TABLE IF NOT EXISTS shopee_income_facts (
  shop_code text NOT NULL,
  source_sha256 text NOT NULL,
  source_row integer NOT NULL CHECK (source_row >= 7),
  order_number text NOT NULL CHECK (order_number ~ '^[A-Z0-9]{8,40}$'),
  return_request_number text,
  ordered_at timestamptz NOT NULL,
  transferred_at timestamptz,
  payout_amount numeric(14,2) NOT NULL,
  components jsonb NOT NULL CHECK (jsonb_typeof(components) = 'object'),
  PRIMARY KEY (shop_code, source_sha256, source_row),
  FOREIGN KEY (shop_code, source_sha256)
    REFERENCES shopee_official_document_sources(shop_code, source_sha256)
);

CREATE INDEX IF NOT EXISTS idx_shopee_income_order
  ON shopee_income_facts (shop_code, order_number);

CREATE TABLE IF NOT EXISTS shopee_seller_balance_facts (
  shop_code text NOT NULL,
  source_sha256 text NOT NULL,
  source_row integer NOT NULL CHECK (source_row >= 19),
  transaction_at timestamptz NOT NULL,
  transaction_type text NOT NULL,
  order_number text,
  direction text NOT NULL CHECK (direction IN ('เงินเข้า', 'เงินออก')),
  amount numeric(14,2) NOT NULL,
  status text NOT NULL,
  balance_after numeric(14,2) NOT NULL,
  PRIMARY KEY (shop_code, source_sha256, source_row),
  FOREIGN KEY (shop_code, source_sha256)
    REFERENCES shopee_official_document_sources(shop_code, source_sha256)
);

CREATE INDEX IF NOT EXISTS idx_shopee_balance_order
  ON shopee_seller_balance_facts (shop_code, order_number);

CREATE TABLE IF NOT EXISTS shopee_return_facts (
  shop_code text NOT NULL,
  source_sha256 text NOT NULL,
  event_key text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('cancelled', 'failed_delivery', 'return_refund')),
  order_number text NOT NULL CHECK (order_number ~ '^[A-Z0-9]{8,40}$'),
  return_request_number text,
  ordered_at timestamptz NOT NULL,
  event_at timestamptz,
  status text NOT NULL,
  reason text,
  amount_label text,
  amount numeric(14,2),
  entry_filename text NOT NULL,
  source_rows jsonb NOT NULL CHECK (jsonb_typeof(source_rows) = 'array'),
  PRIMARY KEY (shop_code, source_sha256, event_key),
  FOREIGN KEY (shop_code, source_sha256)
    REFERENCES shopee_official_document_sources(shop_code, source_sha256)
);

CREATE INDEX IF NOT EXISTS idx_shopee_return_order
  ON shopee_return_facts (shop_code, order_number, event_type);
CREATE INDEX IF NOT EXISTS idx_shopee_return_ordered_at
  ON shopee_return_facts (shop_code, ordered_at);

COMMENT ON TABLE shopee_official_document_sources IS
  'Immutable audit for official Shopee Finance and return/refund/cancel exports. Raw files and customer PII are not stored.';
COMMENT ON TABLE shopee_income_facts IS
  'Order-level payout evidence from My Income Details. Buyer identity and logistics fields are deliberately excluded.';
COMMENT ON TABLE shopee_return_facts IS
  'Privacy-safe order event evidence from the Shopee exceptional-case ZIP. Amounts retain their exact source-column meaning and are not substituted for Business Insights sales.';

COMMIT;
