BEGIN;

-- Shopee demand is not an internal stock-request allocation. These tables own
-- one durable marketplace ledger; no POS, Full Sync or Transfer Delta writes.
CREATE TABLE IF NOT EXISTS shopee004_stock_control (
  singleton smallint PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  mode text NOT NULL CHECK (mode IN ('planned','live','paused')),
  cutover_at timestamptz,
  plan jsonb NOT NULL,
  pos_catalog jsonb NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  CHECK ((mode = 'planned') = (cutover_at IS NULL))
);
CREATE TABLE IF NOT EXISTS shopee004_stock_dirty (
  order_number text PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 1,
  queued_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shopee004_stock_positions (
  order_number text PRIMARY KEY,
  eligibility text NOT NULL CHECK (eligibility IN ('opening','new','legacy')),
  state text NOT NULL CHECK (state IN ('reserved','shipped_unposted','released','review_required','legacy_excluded')),
  reasons jsonb NOT NULL DEFAULT '[]',
  source_snapshot jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shopee004_stock_lines (
  order_number text NOT NULL REFERENCES shopee004_stock_positions(order_number),
  product_code text NOT NULL,
  unit text NOT NULL,
  ordered_quantity bigint NOT NULL CHECK (ordered_quantity > 0),
  reserved_quantity bigint NOT NULL CHECK (reserved_quantity >= 0),
  shipped_unposted_quantity bigint NOT NULL CHECK (shipped_unposted_quantity >= 0),
  PRIMARY KEY (order_number, product_code),
  CHECK (reserved_quantity + shipped_unposted_quantity <= ordered_quantity)
);
CREATE TABLE IF NOT EXISTS shopee004_stock_reviews (
  operation_id uuid PRIMARY KEY,
  order_number text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('cancel-before-dispatch','dispatched','returned-sellable','legacy-in-baseline')),
  quantities jsonb NOT NULL DEFAULT '[]',
  actor text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shopee004_stock_reviews_order ON shopee004_stock_reviews(order_number,recorded_at,operation_id);
CREATE TABLE IF NOT EXISTS shopee004_stock_audit (
  revision bigserial PRIMARY KEY,
  action text NOT NULL,
  order_number text,
  actor text,
  outcome jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shopee004_stock_lines_product ON shopee004_stock_lines(product_code);
CREATE INDEX IF NOT EXISTS shopee004_stock_email_ingested ON shopee_order_events(created_at DESC)
  WHERE shop_code='sc-drug-store';

CREATE OR REPLACE FUNCTION shopee004_mark_stock_dirty() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE active_mode text; dirty_orders text[] := '{}'; scoped_order text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD.shop_code = 'sc-drug-store' THEN dirty_orders := array_append(dirty_orders,OLD.order_number); END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF NEW.shop_code = 'sc-drug-store' THEN dirty_orders := array_append(dirty_orders,NEW.order_number); END IF;
  END IF;
  IF cardinality(dirty_orders)=0 THEN RETURN NULL; END IF;
  -- Fence activation against in-flight ingestion, without serializing readers.
  SELECT mode INTO active_mode FROM shopee004_stock_control WHERE singleton=1 FOR SHARE;
  IF active_mode IN ('live','paused') THEN
    FOR scoped_order IN SELECT DISTINCT unnest(dirty_orders) LOOP
      INSERT INTO shopee004_stock_dirty(order_number) VALUES (scoped_order)
      ON CONFLICT(order_number) DO UPDATE SET revision=shopee004_stock_dirty.revision+1,queued_at=now();
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS shopee004_stock_order_dirty ON shopee_orders;
CREATE TRIGGER shopee004_stock_order_dirty AFTER INSERT OR UPDATE OR DELETE ON shopee_orders
FOR EACH ROW EXECUTE FUNCTION shopee004_mark_stock_dirty();
DROP TRIGGER IF EXISTS shopee004_stock_event_dirty ON shopee_order_events;
CREATE TRIGGER shopee004_stock_event_dirty AFTER INSERT OR UPDATE OR DELETE ON shopee_order_events
FOR EACH ROW EXECUTE FUNCTION shopee004_mark_stock_dirty();

COMMENT ON TABLE shopee004_stock_control IS 'Explicit owner-reviewed cutover, opening pending orders and POS base-unit contract; OFF until activated. No automatic historical replay.';
COMMENT ON TABLE shopee004_stock_reviews IS 'Append-only human physical-evidence decisions. Refund or cancellation emails alone never release stock.';
COMMIT;
