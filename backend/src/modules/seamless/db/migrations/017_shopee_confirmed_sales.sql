BEGIN;
CREATE TABLE IF NOT EXISTS shopee_confirmed_sources (
  shop_code text NOT NULL CHECK (shop_code IN ('sc-drug-store', 'dr-morepen')),
  source_sha256 text NOT NULL UNIQUE CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_filename text NOT NULL,
  observed_at timestamptz NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL CHECK (end_date >= start_date),
  day_count integer NOT NULL CHECK (day_count = end_date - start_date + 1),
  control jsonb NOT NULL CHECK (jsonb_typeof(control) = 'object'),
  imported_by text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_code, source_sha256)
);
CREATE TABLE IF NOT EXISTS shopee_confirmed_daily_facts (
  shop_code text NOT NULL,
  source_sha256 text NOT NULL,
  report_date date NOT NULL,
  sales_total numeric(14,2) NOT NULL CHECK (sales_total >= 0),
  order_count integer NOT NULL CHECK (order_count >= 0),
  cancelled_sales numeric(14,2) NOT NULL CHECK (cancelled_sales >= 0 AND cancelled_sales <= sales_total),
  cancelled_order_count integer NOT NULL CHECK (cancelled_order_count >= 0 AND cancelled_order_count <= order_count),
  returned_sales numeric(14,2) NOT NULL CHECK (returned_sales >= 0),
  returned_order_count integer NOT NULL CHECK (returned_order_count >= 0),
  source_row integer NOT NULL CHECK (source_row >= 5),
  PRIMARY KEY (shop_code, source_sha256, report_date),
  FOREIGN KEY (shop_code, source_sha256) REFERENCES shopee_confirmed_sources(shop_code, source_sha256)
);
CREATE INDEX IF NOT EXISTS idx_shopee_confirmed_day ON shopee_confirmed_daily_facts (shop_code, report_date);
CREATE INDEX IF NOT EXISTS idx_shopee_confirmed_observed ON shopee_confirmed_sources (shop_code, observed_at DESC);
COMMENT ON TABLE shopee_confirmed_daily_facts IS 'Official Shopee shop-stats Confirmed sheet. Sales before cancellations. Report dates are not assumed to be order-creation dates. No order/customer-level data.';
COMMIT;
