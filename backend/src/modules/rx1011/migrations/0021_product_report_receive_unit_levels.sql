ALTER TABLE products
  ADD COLUMN IF NOT EXISTS report_receive_unit_level_id uuid REFERENCES product_unit_levels(id);

CREATE INDEX IF NOT EXISTS idx_products_report_receive_unit_level_id
  ON products(report_receive_unit_level_id);

UPDATE products p
SET report_receive_unit_level_id = (
  SELECT pul.id
  FROM product_unit_levels pul
  WHERE pul.product_id = p.id
    AND COALESCE(pul.is_active, true) = true
  ORDER BY pul.is_sellable DESC, pul.is_base DESC, pul.sort_order ASC, pul.created_at ASC
  LIMIT 1
)
WHERE p.report_receive_unit_level_id IS NULL;
