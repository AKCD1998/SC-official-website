BEGIN;

CREATE TABLE IF NOT EXISTS product_lot_edit_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_lot_id uuid NOT NULL REFERENCES product_lots (id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  previous_lot_no varchar(120) NOT NULL,
  new_lot_no varchar(120) NOT NULL,
  previous_mfg_date date,
  new_mfg_date date,
  previous_exp_date date NOT NULL,
  new_exp_date date NOT NULL,
  reason_text text NOT NULL,
  edited_by uuid NOT NULL REFERENCES users (id),
  edited_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_lot_edit_audits_lot_edited_at
  ON product_lot_edit_audits (product_lot_id, edited_at DESC);

CREATE INDEX IF NOT EXISTS idx_product_lot_edit_audits_product_edited_at
  ON product_lot_edit_audits (product_id, edited_at DESC);

CREATE INDEX IF NOT EXISTS idx_product_lot_edit_audits_editor_edited_at
  ON product_lot_edit_audits (edited_by, edited_at DESC);

COMMENT ON TABLE product_lot_edit_audits IS
  'Append-only audit trail for admin edits to lot metadata such as lot number, manufacturing date, and expiry date.';

COMMENT ON COLUMN product_lot_edit_audits.reason_text IS
  'Required incident-style explanation for why the lot metadata was changed.';

COMMIT;
