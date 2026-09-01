BEGIN;

CREATE INDEX IF NOT EXISTS idx_shopee_orders_shop_ordered_at
  ON shopee_orders (shop_code, ordered_at DESC, order_number ASC)
  WHERE ordered_at IS NOT NULL AND current_status IN ('order_confirmed', 'shipment_due');

COMMIT;
