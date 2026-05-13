CREATE TABLE IF NOT EXISTS dispense_line_lot_correction_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispense_line_id uuid NOT NULL REFERENCES dispense_lines (id),
  dispense_header_id uuid REFERENCES dispense_headers (id),
  stock_movement_id uuid REFERENCES stock_movements (id),
  product_id uuid NOT NULL REFERENCES products (id),
  branch_id uuid NOT NULL REFERENCES locations (id),
  old_lot_id uuid REFERENCES product_lots (id),
  new_lot_id uuid NOT NULL REFERENCES product_lots (id),
  old_lot_no text,
  new_lot_no text NOT NULL,
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0),
  quantity_base numeric(14,3) NOT NULL CHECK (quantity_base > 0),
  unit_level_id uuid NOT NULL REFERENCES product_unit_levels (id),
  reason_text text NOT NULL,
  previous_snapshot jsonb NOT NULL,
  next_snapshot jsonb NOT NULL,
  corrected_by uuid NOT NULL REFERENCES users (id),
  corrected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dispense_line_lot_correction_audits_line_corrected_at
  ON dispense_line_lot_correction_audits (dispense_line_id, corrected_at DESC);

CREATE INDEX IF NOT EXISTS idx_dispense_line_lot_correction_audits_header_corrected_at
  ON dispense_line_lot_correction_audits (dispense_header_id, corrected_at DESC);

CREATE INDEX IF NOT EXISTS idx_dispense_line_lot_correction_audits_product_corrected_at
  ON dispense_line_lot_correction_audits (product_id, corrected_at DESC);

CREATE INDEX IF NOT EXISTS idx_dispense_line_lot_correction_audits_branch_corrected_at
  ON dispense_line_lot_correction_audits (branch_id, corrected_at DESC);

CREATE INDEX IF NOT EXISTS idx_dispense_line_lot_correction_audits_corrected_by
  ON dispense_line_lot_correction_audits (corrected_by, corrected_at DESC);

COMMENT ON TABLE dispense_line_lot_correction_audits IS
  'Append-only audit trail for admin corrective actions that reassign one existing dispense line from one real lot to another and rebalance stock_on_hand accordingly.';

COMMENT ON COLUMN dispense_line_lot_correction_audits.reason_text IS
  'Required admin justification for changing the delivered lot on a historical dispense line.';
