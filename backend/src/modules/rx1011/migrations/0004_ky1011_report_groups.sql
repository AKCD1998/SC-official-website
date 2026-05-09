BEGIN;

CREATE TABLE IF NOT EXISTS report_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(30) NOT NULL UNIQUE,
  thai_name varchar(255) NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_report_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  report_group_id uuid NOT NULL REFERENCES report_groups (id) ON DELETE CASCADE,
  effective_from date NOT NULL,
  effective_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_product_report_groups UNIQUE (product_id, report_group_id, effective_from),
  CONSTRAINT ck_product_report_groups_effective_dates
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_product_report_groups_report_group_id
  ON product_report_groups (report_group_id);

CREATE INDEX IF NOT EXISTS idx_product_report_groups_product_id
  ON product_report_groups (product_id);

CREATE INDEX IF NOT EXISTS idx_product_report_groups_product_group_effective_to
  ON product_report_groups (product_id, report_group_id, effective_to);

COMMENT ON TABLE report_groups IS 'กลุ่มรายงานตามกฎหมาย เช่น ข.ย.10, ข.ย.11 และกลุ่มอนาคต';
COMMENT ON TABLE product_report_groups IS 'ความสัมพันธ์สินค้า-กลุ่มรายงานแบบ many-to-many พร้อมช่วงวันที่มีผล';

COMMENT ON COLUMN report_groups.code IS 'รหัสกลุ่มรายงาน เช่น KY10, KY11';
COMMENT ON COLUMN report_groups.thai_name IS 'ชื่อกลุ่มรายงานภาษาไทย';
COMMENT ON COLUMN product_report_groups.effective_from IS 'วันที่เริ่มมีผลของการจัดเข้ากลุ่มรายงาน';
COMMENT ON COLUMN product_report_groups.effective_to IS 'วันที่สิ้นสุดผลบังคับ (NULL = ยังมีผล)';

INSERT INTO report_groups (code, thai_name, description, is_active)
VALUES
  ('KY10', 'บัญชีการขายยาควบคุมพิเศษ (ข.ย.10)', 'กลุ่มรายงานสำหรับบันทึก ข.ย.10', true),
  ('KY11', 'บัญชีการขายยาอันตราย (ข.ย.11)', 'กลุ่มรายงานสำหรับบันทึก ข.ย.11 ตามรายการที่ อย. กำหนด', true)
ON CONFLICT (code) DO UPDATE
SET
  thai_name = EXCLUDED.thai_name,
  description = EXCLUDED.description,
  is_active = EXCLUDED.is_active,
  updated_at = now();

COMMIT;
