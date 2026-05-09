-- 0012_stock_movement_occurred_at_corrections.sql
-- Purpose:
-- - Keep original stock_movements.occurred_at immutable for legacy logic and traceability.
-- - Allow admin-facing timelines/reports to use a corrected effective timestamp.
-- - Persist a full audit trail for every correction attempt.

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS corrected_occurred_at timestamptz;

CREATE TABLE IF NOT EXISTS stock_movement_occurred_at_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_id uuid NOT NULL REFERENCES stock_movements (id) ON DELETE CASCADE,
  original_occurred_at timestamptz NOT NULL,
  previous_corrected_occurred_at timestamptz,
  previous_effective_occurred_at timestamptz NOT NULL,
  new_corrected_occurred_at timestamptz,
  new_effective_occurred_at timestamptz NOT NULL,
  reason_text text NOT NULL,
  edited_by uuid NOT NULL REFERENCES users (id),
  edited_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_effective_occurred_at
  ON stock_movements ((COALESCE(corrected_occurred_at, occurred_at)) DESC);

CREATE INDEX IF NOT EXISTS idx_stock_movement_occurred_at_audits_movement_edited_at
  ON stock_movement_occurred_at_audits (movement_id, edited_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_movement_occurred_at_audits_edited_by
  ON stock_movement_occurred_at_audits (edited_by, edited_at DESC);

COMMENT ON COLUMN stock_movements.corrected_occurred_at IS
  'วันที่เวลาแก้ไขเพื่อใช้เป็น effective occurred_at สำหรับการแสดงผล/รายงาน โดยไม่แก้ค่าต้นฉบับ';

COMMENT ON TABLE stock_movement_occurred_at_audits IS
  'ประวัติการแก้ไข effective occurred_at ของ stock_movements พร้อมเหตุผลและผู้แก้';
