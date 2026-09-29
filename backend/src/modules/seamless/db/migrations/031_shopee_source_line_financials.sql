BEGIN;
ALTER TABLE shopee_sales_order_facts
  ADD COLUMN IF NOT EXISTS source_line_components jsonb
    CHECK (source_line_components IS NULL OR
      (jsonb_typeof(source_line_components) = 'array'
        AND jsonb_array_length(source_line_components) = jsonb_array_length(items)));
COMMENT ON COLUMN shopee_sales_order_facts.source_line_components IS
  'Original Order All net-sale and Shopee product discount per item, in source row order. Same-hash replay may fill NULL only; seller order vouchers are not line allocations. Separate from any older incomplete line_financials field.';
COMMIT;
