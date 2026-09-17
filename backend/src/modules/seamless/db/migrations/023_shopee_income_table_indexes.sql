BEGIN;

CREATE INDEX IF NOT EXISTS idx_shopee_income_ordered_at
  ON shopee_income_facts (ordered_at DESC, shop_code, order_number);

CREATE INDEX IF NOT EXISTS idx_shopee_income_transferred_at
  ON shopee_income_facts (transferred_at DESC, shop_code, order_number)
  WHERE transferred_at IS NOT NULL;

COMMIT;
