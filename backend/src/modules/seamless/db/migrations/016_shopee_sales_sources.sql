BEGIN;

-- Immutable, privacy-safe evidence from seller-selected original All Orders
-- exports. Never fabricate Gmail events or overwrite email-derived history.
CREATE TABLE IF NOT EXISTS shopee_sales_sources (
  shop_code text NOT NULL CHECK (shop_code IN ('sc-drug-store', 'dr-morepen')),
  source_sha256 text NOT NULL UNIQUE CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_filename text NOT NULL,
  observed_at timestamptz NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL CHECK (end_date >= start_date),
  order_count integer NOT NULL CHECK (order_count >= 0),
  imported_by text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_code, source_sha256)
);

CREATE TABLE IF NOT EXISTS shopee_sales_order_facts (
  shop_code text NOT NULL,
  source_sha256 text NOT NULL,
  order_number text NOT NULL CHECK (order_number ~ '^[A-Z0-9]{8,40}$'),
  ordered_at timestamptz NOT NULL,
  status text NOT NULL,
  excluded boolean NOT NULL,
  item_subtotal numeric(14,2) NOT NULL CHECK (item_subtotal >= 0),
  seller_voucher numeric(14,2) NOT NULL CHECK (seller_voucher >= 0 AND seller_voucher <= item_subtotal),
  shopee_product_discount numeric(14,2) NOT NULL CHECK (shopee_product_discount >= 0),
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  source_rows jsonb NOT NULL CHECK (jsonb_typeof(source_rows) = 'array'),
  PRIMARY KEY (shop_code, source_sha256, order_number),
  FOREIGN KEY (shop_code, source_sha256) REFERENCES shopee_sales_sources(shop_code, source_sha256)
);
CREATE INDEX IF NOT EXISTS idx_shopee_sales_facts_order
  ON shopee_sales_order_facts (shop_code, order_number);
CREATE INDEX IF NOT EXISTS idx_shopee_sales_source_observed
  ON shopee_sales_sources (shop_code, observed_at DESC);

COMMENT ON TABLE shopee_sales_order_facts IS 'Order-grain sales components from original All Orders files. Seller voucher counted once per order. No buyer, address, phone, or raw workbook data.';

COMMIT;
