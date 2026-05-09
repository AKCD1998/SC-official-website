BEGIN;

CREATE TABLE IF NOT EXISTS product_lot_normalization_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products (id),
  operation_type varchar(20) NOT NULL CHECK (operation_type IN ('RENAME', 'MERGE')),
  source_lot_id uuid NOT NULL,
  target_lot_id uuid NOT NULL,
  source_lot_no varchar(120) NOT NULL,
  target_lot_no varchar(120) NOT NULL,
  source_mfg_date date,
  target_mfg_date date,
  source_exp_date date NOT NULL,
  target_exp_date date NOT NULL,
  reason_text text NOT NULL,
  stock_on_hand_rows_rebuilt integer NOT NULL DEFAULT 0,
  stock_movement_rows_updated integer NOT NULL DEFAULT 0,
  dispense_line_rows_updated integer NOT NULL DEFAULT 0,
  transfer_request_rows_updated integer NOT NULL DEFAULT 0,
  incident_item_rows_updated integer NOT NULL DEFAULT 0,
  incident_resolution_rows_updated integer NOT NULL DEFAULT 0,
  stock_movement_delete_audit_rows_updated integer NOT NULL DEFAULT 0,
  lot_whitelist_rows_removed integer NOT NULL DEFAULT 0,
  normalized_by uuid NOT NULL REFERENCES users (id),
  normalized_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_lot_normalization_audits_product_at
  ON product_lot_normalization_audits (product_id, normalized_at DESC);

CREATE INDEX IF NOT EXISTS idx_product_lot_normalization_audits_source_lot
  ON product_lot_normalization_audits (source_lot_id, normalized_at DESC);

CREATE INDEX IF NOT EXISTS idx_product_lot_normalization_audits_target_lot
  ON product_lot_normalization_audits (target_lot_id, normalized_at DESC);

COMMENT ON TABLE product_lot_normalization_audits IS
  'Audit trail for admin lot normalization. RENAME changes a single lot value; MERGE rewrites references from a typo lot into a canonical lot.';

COMMENT ON COLUMN product_lot_normalization_audits.source_lot_id IS
  'Original product_lots.id. For MERGE this source lot row is deleted after references move, so this column intentionally has no FK.';

COMMENT ON COLUMN product_lot_normalization_audits.target_lot_id IS
  'Canonical product_lots.id retained after normalization. For RENAME this is the same row as source_lot_id.';

COMMIT;
