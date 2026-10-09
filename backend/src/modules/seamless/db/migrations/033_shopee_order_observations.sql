BEGIN;
CREATE TABLE shopee_order_observation_batches (
  batch_id uuid PRIMARY KEY,
  shop_code text NOT NULL CHECK (shop_code IN ('sc-drug-store','dr-morepen')),
  observed_at timestamptz NOT NULL,
  payload_sha256 text NOT NULL,
  coverage jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE shopee_live_orders (
  shop_code text NOT NULL CHECK (shop_code IN ('sc-drug-store','dr-morepen')),
  order_number text NOT NULL CHECK (order_number ~ '^[A-Z0-9]{8,40}$'),
  internal_order_id text CHECK (internal_order_id ~ '^[0-9]{8,24}$'),
  snapshot jsonb NOT NULL,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  PRIMARY KEY (shop_code, order_number)
);
CREATE TABLE shopee_order_observation_events (
  batch_id uuid NOT NULL REFERENCES shopee_order_observation_batches(batch_id),
  shop_code text NOT NULL,
  order_number text NOT NULL,
  observation jsonb NOT NULL,
  PRIMARY KEY (batch_id, order_number)
);
CREATE INDEX shopee_live_orders_recent ON shopee_live_orders(last_observed_at DESC);
CREATE INDEX shopee_paid_order_evidence ON shopee_sales_order_facts(shop_code,order_number,source_sha256) WHERE paid_at IS NOT NULL;
COMMENT ON TABLE shopee_live_orders IS 'Rendered Seller Centre business status observations. No buyer identifiers or raw page content. Independent of official financial reports and email events.';
COMMIT;
