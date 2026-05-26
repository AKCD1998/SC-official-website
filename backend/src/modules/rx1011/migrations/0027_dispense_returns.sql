CREATE TABLE IF NOT EXISTS dispense_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispense_header_id uuid NOT NULL REFERENCES dispense_headers (id) ON DELETE CASCADE,
  dispense_line_id uuid NOT NULL REFERENCES dispense_lines (id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES locations (id),
  product_id uuid NOT NULL REFERENCES products (id),
  lot_id uuid REFERENCES product_lots (id),
  unit_level_id uuid NOT NULL REFERENCES product_unit_levels (id),
  returned_quantity numeric(18, 6) NOT NULL CHECK (returned_quantity > 0),
  returned_quantity_base numeric(18, 6) NOT NULL CHECK (returned_quantity_base > 0),
  reason_text text,
  note_text text,
  return_source text NOT NULL DEFAULT 'DELIVER_UI',
  reference_key text,
  stock_movement_id uuid UNIQUE REFERENCES stock_movements (id),
  returned_by uuid REFERENCES users (id),
  returned_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dispense_returns_line_returned_at
  ON dispense_returns (dispense_line_id, returned_at DESC);

CREATE INDEX IF NOT EXISTS idx_dispense_returns_header_returned_at
  ON dispense_returns (dispense_header_id, returned_at DESC);

CREATE INDEX IF NOT EXISTS idx_dispense_returns_branch_returned_at
  ON dispense_returns (branch_id, returned_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dispense_returns_line_reference_key
  ON dispense_returns (dispense_line_id, reference_key)
  WHERE reference_key IS NOT NULL;

COMMENT ON TABLE dispense_returns IS
  'Audit-preserving return records for dispense lines. Original dispense history remains immutable while stock is restored through a positive stock movement.';

COMMENT ON COLUMN dispense_returns.returned_quantity IS
  'Returned quantity expressed in the same unit_level as the original dispense line.';

COMMENT ON COLUMN dispense_returns.returned_quantity_base IS
  'Returned quantity converted to the product base unit for stock_on_hand restoration.';

COMMENT ON COLUMN dispense_returns.return_source IS
  'Origin of the return action, for example DELIVER_UI or RETROACTIVE_REPAIR.';
