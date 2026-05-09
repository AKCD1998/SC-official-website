ALTER TABLE product_unit_levels
ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

UPDATE product_unit_levels
SET is_active = true
WHERE is_active IS DISTINCT FROM true;

CREATE INDEX IF NOT EXISTS idx_product_unit_levels_product_active
  ON product_unit_levels (product_id, is_active, sort_order, created_at);
