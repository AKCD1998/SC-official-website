BEGIN;

-- Business Insights "confirmed" sales are bucketed by the Shopee payment
-- timestamp, not by the order-created timestamp.  Keep both timestamps: they
-- answer different accounting questions and must never be substituted.
ALTER TABLE shopee_sales_order_facts
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_shopee_sales_facts_paid_at
  ON shopee_sales_order_facts (shop_code, paid_at, order_number)
  WHERE paid_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shopee_sales_facts_completed_at
  ON shopee_sales_order_facts (shop_code, completed_at, order_number)
  WHERE completed_at IS NOT NULL;

COMMENT ON COLUMN shopee_sales_order_facts.ordered_at IS
  'Shopee วันที่ทำการสั่งซื้อ. This is not the Business Insights confirmed-sales date basis.';
COMMENT ON COLUMN shopee_sales_order_facts.paid_at IS
  'Shopee เวลาการชำระสินค้า. NULL means Shopee exported -/blank; only non-NULL rows can enter the confirmed Sales batch.';
COMMENT ON COLUMN shopee_sales_order_facts.completed_at IS
  'Shopee เวลาที่ทำการสั่งซื้อสำเร็จ, retained separately from ordered/payment/payout dates.';

COMMIT;
