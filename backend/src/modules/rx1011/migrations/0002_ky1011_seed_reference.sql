BEGIN;

INSERT INTO locations (code, name, location_type, is_active)
VALUES
  ('001', 'Branch 001', 'BRANCH', true),
  ('003', 'Branch 003', 'BRANCH', true),
  ('004', 'Branch 004', 'BRANCH', true),
  ('OFFICE_MAIN', 'Head Office', 'OFFICE', true)
ON CONFLICT (code) DO UPDATE
SET
  name = EXCLUDED.name,
  location_type = EXCLUDED.location_type,
  is_active = EXCLUDED.is_active,
  updated_at = now();

INSERT INTO users (username, password_hash, full_name, role, is_active)
VALUES
  ('system', '$2b$10$M2M6PmdM1Q9hIBDwa7Jx0u2fBw8LZg/XiP7nM7G0X2j4VdZG2M53a', 'System User', 'ADMIN', true)
ON CONFLICT (username) DO UPDATE
SET
  full_name = EXCLUDED.full_name,
  role = EXCLUDED.role,
  is_active = EXCLUDED.is_active,
  updated_at = now();

INSERT INTO unit_types (code, name_en, name_th, unit_kind, symbol, precision_scale, is_active)
VALUES
  ('MG', 'Milligram', 'มิลลิกรัม', 'MASS', 'mg', 4, true),
  ('MCG', 'Microgram', 'ไมโครกรัม', 'MASS', 'mcg', 4, true),
  ('G', 'Gram', 'กรัม', 'MASS', 'g', 4, true),
  ('ML', 'Milliliter', 'มิลลิลิตร', 'VOLUME', 'mL', 4, true),
  ('TABLET', 'Tablet', 'เม็ด', 'COUNT', 'tab', 0, true),
  ('CAPSULE', 'Capsule', 'แคปซูล', 'COUNT', 'cap', 0, true),
  ('BLISTER', 'Blister', 'แผง', 'PACKAGE', 'blister', 0, true),
  ('BOTTLE', 'Bottle', 'ขวด', 'PACKAGE', 'bottle', 0, true),
  ('BOX', 'Box', 'กล่อง', 'PACKAGE', 'box', 0, true),
  ('TUBE', 'Tube', 'หลอด', 'PACKAGE', 'tube', 0, true),
  ('INHALATION', 'Inhalation', 'ครั้งการพ่น', 'COUNT', 'inh', 0, true),
  ('DEVICE', 'Device', 'อุปกรณ์', 'PACKAGE', 'device', 0, true)
ON CONFLICT (code) DO UPDATE
SET
  name_en = EXCLUDED.name_en,
  name_th = EXCLUDED.name_th,
  unit_kind = EXCLUDED.unit_kind,
  symbol = EXCLUDED.symbol,
  precision_scale = EXCLUDED.precision_scale,
  is_active = EXCLUDED.is_active;

INSERT INTO dosage_forms (code, name_en, name_th, dosage_form_group, parent_form_id, is_active)
VALUES
  ('TABLET', 'Tablet', 'ยาเม็ด', 'SOLID_ORAL', NULL, true),
  ('CAPSULE', 'Capsule', 'ยาแคปซูล', 'SOLID_ORAL', NULL, true),
  ('ORAL_SOLUTION', 'Oral Solution', 'ยาน้ำใสรับประทาน', 'LIQUID_ORAL', NULL, true),
  ('SUSPENSION', 'Suspension', 'ยาน้ำแขวนตะกอน', 'LIQUID_ORAL', NULL, true),
  ('CREAM', 'Cream', 'ครีม', 'TOPICAL', NULL, true),
  ('GEL', 'Gel', 'เจล', 'TOPICAL', NULL, true),
  ('INHALER', 'Inhaler', 'ยาพ่น', 'INHALATION', NULL, true)
ON CONFLICT (code) DO UPDATE
SET
  name_en = EXCLUDED.name_en,
  name_th = EXCLUDED.name_th,
  dosage_form_group = EXCLUDED.dosage_form_group,
  parent_form_id = EXCLUDED.parent_form_id,
  is_active = EXCLUDED.is_active;

INSERT INTO dosage_forms (code, name_en, name_th, dosage_form_group, parent_form_id, is_active)
SELECT
  'ACCUHALER',
  'Accuhaler',
  'แอคคิวเฮเลอร์',
  'INHALATION',
  parent.id,
  true
FROM dosage_forms parent
WHERE parent.code = 'INHALER'
ON CONFLICT (code) DO UPDATE
SET
  name_en = EXCLUDED.name_en,
  name_th = EXCLUDED.name_th,
  dosage_form_group = EXCLUDED.dosage_form_group,
  parent_form_id = EXCLUDED.parent_form_id,
  is_active = EXCLUDED.is_active;

INSERT INTO dosage_forms (code, name_en, name_th, dosage_form_group, parent_form_id, is_active)
SELECT
  'TURBUHALER',
  'Turbuhaler',
  'เทอร์บูเฮเลอร์',
  'INHALATION',
  parent.id,
  true
FROM dosage_forms parent
WHERE parent.code = 'INHALER'
ON CONFLICT (code) DO UPDATE
SET
  name_en = EXCLUDED.name_en,
  name_th = EXCLUDED.name_th,
  dosage_form_group = EXCLUDED.dosage_form_group,
  parent_form_id = EXCLUDED.parent_form_id,
  is_active = EXCLUDED.is_active;

INSERT INTO product_categories (code, name_en, name_th, is_active)
VALUES
  ('CONTROLLED_MED', 'Controlled Medication', 'ยาควบคุม', true)
ON CONFLICT (code) DO UPDATE
SET
  name_en = EXCLUDED.name_en,
  name_th = EXCLUDED.name_th,
  is_active = EXCLUDED.is_active;

INSERT INTO price_tiers (code, name_en, name_th, is_default, priority, is_active)
VALUES
  ('RETAIL', 'Retail', 'ราคาขายปลีก', true, 10, true),
  ('HOSPITAL', 'Hospital Contract', 'ราคาสัญญาโรงพยาบาล', false, 20, true)
ON CONFLICT (code) DO UPDATE
SET
  name_en = EXCLUDED.name_en,
  name_th = EXCLUDED.name_th,
  is_default = EXCLUDED.is_default,
  priority = EXCLUDED.priority,
  is_active = EXCLUDED.is_active;

INSERT INTO dispensing_rules (
  rule_name,
  rule_scope,
  dosage_form_group,
  product_category_id,
  product_id,
  max_qty,
  unit_type_id,
  rule_period,
  priority,
  is_active,
  note_text
)
SELECT
  'SOLID_ORAL_MAX_2_BLISTERS',
  'DOSAGE_FORM_GROUP',
  'SOLID_ORAL',
  NULL,
  NULL,
  2,
  ut.id,
  'PER_VISIT',
  10,
  true,
  'tablet/capsule จำกัดไม่เกิน 2 แผงต่อคนต่อการมารับยา 1 ครั้ง'
FROM unit_types ut
WHERE ut.code = 'BLISTER'
ON CONFLICT (rule_name) DO UPDATE
SET
  rule_scope = EXCLUDED.rule_scope,
  dosage_form_group = EXCLUDED.dosage_form_group,
  product_category_id = EXCLUDED.product_category_id,
  product_id = EXCLUDED.product_id,
  max_qty = EXCLUDED.max_qty,
  unit_type_id = EXCLUDED.unit_type_id,
  rule_period = EXCLUDED.rule_period,
  priority = EXCLUDED.priority,
  is_active = EXCLUDED.is_active,
  note_text = EXCLUDED.note_text,
  updated_at = now();

INSERT INTO dispensing_rules (
  rule_name,
  rule_scope,
  dosage_form_group,
  product_category_id,
  product_id,
  max_qty,
  unit_type_id,
  rule_period,
  priority,
  is_active,
  note_text
)
SELECT
  'LIQUID_ORAL_MAX_3_BOTTLES',
  'DOSAGE_FORM_GROUP',
  'LIQUID_ORAL',
  NULL,
  NULL,
  3,
  ut.id,
  'PER_VISIT',
  20,
  true,
  'ยาน้ำรับประทาน จำกัดไม่เกิน 3 ขวดต่อคนต่อการมารับยา 1 ครั้ง'
FROM unit_types ut
WHERE ut.code = 'BOTTLE'
ON CONFLICT (rule_name) DO UPDATE
SET
  rule_scope = EXCLUDED.rule_scope,
  dosage_form_group = EXCLUDED.dosage_form_group,
  product_category_id = EXCLUDED.product_category_id,
  product_id = EXCLUDED.product_id,
  max_qty = EXCLUDED.max_qty,
  unit_type_id = EXCLUDED.unit_type_id,
  rule_period = EXCLUDED.rule_period,
  priority = EXCLUDED.priority,
  is_active = EXCLUDED.is_active,
  note_text = EXCLUDED.note_text,
  updated_at = now();

COMMIT;
