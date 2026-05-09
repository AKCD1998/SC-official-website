BEGIN;

DO $$
BEGIN
  CREATE TYPE transfer_request_status AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS inventory_transfer_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_location_id uuid NOT NULL REFERENCES locations (id),
  to_location_id uuid NOT NULL REFERENCES locations (id),
  product_id uuid NOT NULL REFERENCES products (id),
  lot_id uuid NOT NULL REFERENCES product_lots (id),
  unit_level_id uuid NOT NULL REFERENCES product_unit_levels (id),
  base_unit_level_id uuid NOT NULL REFERENCES product_unit_levels (id),
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0),
  quantity_base numeric(12,3) NOT NULL CHECK (quantity_base > 0),
  note_text text,
  status transfer_request_status NOT NULL DEFAULT 'PENDING',
  requested_by uuid NOT NULL REFERENCES users (id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users (id),
  decided_at timestamptz,
  decision_note text,
  transfer_out_movement_id uuid REFERENCES stock_movements (id),
  transfer_in_movement_id uuid REFERENCES stock_movements (id),
  return_movement_id uuid REFERENCES stock_movements (id),
  CONSTRAINT ck_transfer_request_locations_differ CHECK (from_location_id <> to_location_id),
  CONSTRAINT ck_transfer_request_decision_state CHECK (
    (status = 'PENDING' AND decided_by IS NULL AND decided_at IS NULL)
    OR (status IN ('ACCEPTED', 'REJECTED') AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_transfer_requests_to_status_requested_at
  ON inventory_transfer_requests (to_location_id, status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_transfer_requests_from_status_requested_at
  ON inventory_transfer_requests (from_location_id, status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_transfer_requests_product_requested_at
  ON inventory_transfer_requests (product_id, requested_at DESC);

COMMENT ON TABLE inventory_transfer_requests IS
  'คำขอโอนสินค้าระหว่างสาขาที่รอปลายทางยืนยันก่อนรับเข้า stock จริง';

COMMENT ON COLUMN inventory_transfer_requests.transfer_out_movement_id IS
  'Ledger ฝั่งต้นทางที่ตัด stock ออกตอนสร้างคำขอโอน';

COMMENT ON COLUMN inventory_transfer_requests.transfer_in_movement_id IS
  'Ledger ฝั่งปลายทางที่รับเข้า stock หลังยืนยัน';

COMMENT ON COLUMN inventory_transfer_requests.return_movement_id IS
  'Ledger ฝั่งต้นทางเมื่อปลายทางปฏิเสธและระบบคืน stock กลับ';

COMMIT;
