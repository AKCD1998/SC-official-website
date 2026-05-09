BEGIN;

CREATE TABLE IF NOT EXISTS stock_movement_delete_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deleted_movement_id uuid NOT NULL UNIQUE,
  movement_type movement_type NOT NULL,
  product_id uuid NOT NULL REFERENCES products (id),
  lot_id uuid REFERENCES product_lots (id),
  from_location_id uuid REFERENCES locations (id),
  to_location_id uuid REFERENCES locations (id),
  quantity numeric(12,3) NOT NULL,
  quantity_base numeric(18,6) NOT NULL,
  unit_level_id uuid NOT NULL REFERENCES product_unit_levels (id),
  occurred_at timestamptz NOT NULL,
  source_ref_type text,
  source_ref_id uuid,
  note_text text,
  movement_snapshot jsonb NOT NULL,
  reason_text text NOT NULL,
  reversed_branch_id uuid NOT NULL REFERENCES locations (id),
  reversed_delta_qty_base numeric(18,6) NOT NULL,
  deleted_by uuid NOT NULL REFERENCES users (id),
  deleted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_movement_delete_audits_deleted_at
  ON stock_movement_delete_audits (deleted_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_movement_delete_audits_product_deleted_at
  ON stock_movement_delete_audits (product_id, deleted_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_movement_delete_audits_deleted_by
  ON stock_movement_delete_audits (deleted_by, deleted_at DESC);

COMMENT ON TABLE stock_movement_delete_audits IS
  'Audit trail for admin-deleted stock movement rows. Stores the full deleted movement snapshot plus the stock_on_hand reversal applied before deletion.';

COMMENT ON COLUMN stock_movement_delete_audits.deleted_movement_id IS
  'Original stock_movements.id that was deleted by admin action.';

COMMENT ON COLUMN stock_movement_delete_audits.reversed_delta_qty_base IS
  'Base-unit delta applied to stock_on_hand to reverse the deleted movement.';

COMMIT;
