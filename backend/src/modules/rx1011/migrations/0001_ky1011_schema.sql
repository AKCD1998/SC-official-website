BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  CREATE TYPE location_type AS ENUM (
    'BRANCH',
    'OFFICE',
    'MANUFACTURER',
    'WHOLESALER',
    'VENDOR',
    'WAREHOUSE',
    'OTHER'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE user_role AS ENUM ('PHARMACIST', 'ADMIN', 'OPERATOR');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE sex_type AS ENUM ('MALE', 'FEMALE', 'OTHER', 'UNKNOWN');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE movement_type AS ENUM (
    'RECEIVE',
    'TRANSFER_OUT',
    'TRANSFER_IN',
    'DISPENSE',
    'ADJUST'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE dosage_form_group AS ENUM (
    'SOLID_ORAL',
    'LIQUID_ORAL',
    'TOPICAL',
    'INHALATION',
    'OTHER'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE rule_scope AS ENUM ('DOSAGE_FORM_GROUP', 'PRODUCT_CATEGORY', 'PRODUCT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE rule_period AS ENUM ('PER_VISIT', 'PER_DAY');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE unit_kind AS ENUM ('MASS', 'VOLUME', 'COUNT', 'PACKAGE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(30) NOT NULL UNIQUE,
  name text NOT NULL,
  location_type location_type NOT NULL,
  parent_location_id uuid REFERENCES locations (id),
  license_no text,
  tax_id text,
  address_line1 text,
  subdistrict text,
  district text,
  province text,
  postal_code text,
  country text DEFAULT 'TH',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username varchar(80) NOT NULL UNIQUE,
  password_hash text NOT NULL,
  full_name text,
  role user_role NOT NULL DEFAULT 'OPERATOR',
  is_active boolean NOT NULL DEFAULT true,
  signature_hash text,
  signature_token text,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pid varchar(30) NOT NULL UNIQUE,
  full_name text NOT NULL,
  birth_date date,
  sex sex_type NOT NULL DEFAULT 'UNKNOWN',
  card_issue_place text,
  card_issued_date date,
  card_expiry_date date,
  address_line1 text,
  address_line2 text,
  subdistrict text,
  district text,
  province text,
  postal_code text,
  country text DEFAULT 'TH',
  address_raw_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_patient_card_dates
    CHECK (
      card_expiry_date IS NULL
      OR card_issued_date IS NULL
      OR card_expiry_date >= card_issued_date
    )
);

CREATE TABLE IF NOT EXISTS unit_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(40) NOT NULL UNIQUE,
  name_en varchar(100) NOT NULL,
  name_th varchar(100),
  unit_kind unit_kind NOT NULL,
  symbol varchar(20),
  precision_scale smallint NOT NULL DEFAULT 3 CHECK (precision_scale BETWEEN 0 AND 6),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dosage_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(60) NOT NULL UNIQUE,
  name_en varchar(100) NOT NULL,
  name_th varchar(100),
  dosage_form_group dosage_form_group NOT NULL,
  parent_form_id uuid REFERENCES dosage_forms (id),
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS product_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(60) NOT NULL UNIQUE,
  name_en varchar(100) NOT NULL,
  name_th varchar(100),
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS active_ingredients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(80) NOT NULL UNIQUE,
  name_en varchar(255) NOT NULL,
  name_th varchar(255),
  cas_number varchar(80),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code varchar(80) UNIQUE,
  trade_name text NOT NULL,
  generic_name text,
  dosage_form_id uuid NOT NULL REFERENCES dosage_forms (id),
  product_category_id uuid REFERENCES product_categories (id),
  manufacturer_location_id uuid REFERENCES locations (id),
  is_controlled boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  note_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_ingredients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  active_ingredient_id uuid NOT NULL REFERENCES active_ingredients (id),
  strength_numerator numeric(12,4) NOT NULL CHECK (strength_numerator > 0),
  numerator_unit_id uuid NOT NULL REFERENCES unit_types (id),
  strength_denominator numeric(12,4),
  denominator_unit_id uuid REFERENCES unit_types (id),
  sort_order smallint NOT NULL DEFAULT 1 CHECK (sort_order > 0),
  CONSTRAINT uq_product_ingredient UNIQUE (product_id, active_ingredient_id),
  CONSTRAINT ck_product_ingredient_denominator
    CHECK (
      (strength_denominator IS NULL AND denominator_unit_id IS NULL)
      OR (strength_denominator > 0 AND denominator_unit_id IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS product_unit_levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  code varchar(50) NOT NULL,
  display_name text NOT NULL,
  unit_type_id uuid NOT NULL REFERENCES unit_types (id),
  is_base boolean NOT NULL DEFAULT false,
  is_sellable boolean NOT NULL DEFAULT true,
  sort_order smallint NOT NULL DEFAULT 1 CHECK (sort_order > 0),
  barcode text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_product_unit_level_product_id_id UNIQUE (product_id, id),
  CONSTRAINT uq_product_unit_level_code UNIQUE (product_id, code),
  CONSTRAINT uq_product_unit_level_order UNIQUE (product_id, sort_order)
);

CREATE TABLE IF NOT EXISTS product_unit_conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  parent_unit_level_id uuid NOT NULL REFERENCES product_unit_levels (id) ON DELETE CASCADE,
  child_unit_level_id uuid NOT NULL REFERENCES product_unit_levels (id) ON DELETE CASCADE,
  multiplier numeric(12,4) NOT NULL CHECK (multiplier > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_product_unit_conversion UNIQUE (product_id, parent_unit_level_id, child_unit_level_id),
  CONSTRAINT fk_product_unit_conversion_parent
    FOREIGN KEY (product_id, parent_unit_level_id)
    REFERENCES product_unit_levels (product_id, id)
    ON DELETE CASCADE,
  CONSTRAINT fk_product_unit_conversion_child
    FOREIGN KEY (product_id, child_unit_level_id)
    REFERENCES product_unit_levels (product_id, id)
    ON DELETE CASCADE,
  CONSTRAINT ck_product_unit_conversion_self CHECK (parent_unit_level_id <> child_unit_level_id)
);

CREATE TABLE IF NOT EXISTS price_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(50) NOT NULL UNIQUE,
  name_en varchar(100) NOT NULL,
  name_th varchar(100),
  is_default boolean NOT NULL DEFAULT false,
  priority smallint NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  unit_level_id uuid NOT NULL REFERENCES product_unit_levels (id) ON DELETE CASCADE,
  price_tier_id uuid NOT NULL REFERENCES price_tiers (id),
  price numeric(12,2) NOT NULL CHECK (price >= 0),
  currency_code char(3) NOT NULL DEFAULT 'THB',
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_product_prices_product_unit_level
    FOREIGN KEY (product_id, unit_level_id)
    REFERENCES product_unit_levels (product_id, id)
    ON DELETE CASCADE,
  CONSTRAINT uq_product_price_effective UNIQUE (product_id, unit_level_id, price_tier_id, effective_from),
  CONSTRAINT ck_product_price_effective_dates
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE IF NOT EXISTS product_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  lot_no varchar(120) NOT NULL,
  mfg_date date,
  exp_date date NOT NULL,
  manufacturer_location_id uuid REFERENCES locations (id),
  manufacturer_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_product_lot_product_id_id UNIQUE (product_id, id),
  CONSTRAINT uq_product_lot UNIQUE (product_id, lot_no, exp_date),
  CONSTRAINT ck_product_lot_dates CHECK (mfg_date IS NULL OR exp_date >= mfg_date)
);

CREATE TABLE IF NOT EXISTS dispense_headers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES locations (id),
  patient_id uuid NOT NULL REFERENCES patients (id),
  pharmacist_user_id uuid NOT NULL REFERENCES users (id),
  dispensed_at timestamptz NOT NULL DEFAULT now(),
  signature_hash text,
  signature_token text,
  note_text text,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dispense_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  header_id uuid NOT NULL REFERENCES dispense_headers (id) ON DELETE CASCADE,
  line_no integer NOT NULL CHECK (line_no > 0),
  product_id uuid NOT NULL REFERENCES products (id),
  lot_id uuid REFERENCES product_lots (id),
  unit_level_id uuid NOT NULL REFERENCES product_unit_levels (id),
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_price numeric(12,2) CHECK (unit_price IS NULL OR unit_price >= 0),
  line_total numeric(14,2) CHECK (line_total IS NULL OR line_total >= 0),
  note_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_dispense_lines_product_unit_level
    FOREIGN KEY (product_id, unit_level_id)
    REFERENCES product_unit_levels (product_id, id),
  CONSTRAINT fk_dispense_lines_product_lot
    FOREIGN KEY (product_id, lot_id)
    REFERENCES product_lots (product_id, id),
  CONSTRAINT uq_dispense_line_no UNIQUE (header_id, line_no)
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_type movement_type NOT NULL,
  from_location_id uuid REFERENCES locations (id),
  to_location_id uuid REFERENCES locations (id),
  product_id uuid NOT NULL REFERENCES products (id),
  lot_id uuid REFERENCES product_lots (id),
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_level_id uuid NOT NULL REFERENCES product_unit_levels (id),
  dispense_line_id uuid REFERENCES dispense_lines (id),
  source_ref_type text,
  source_ref_id uuid,
  occurred_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES users (id),
  note_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_stock_movements_product_unit_level
    FOREIGN KEY (product_id, unit_level_id)
    REFERENCES product_unit_levels (product_id, id),
  CONSTRAINT fk_stock_movements_product_lot
    FOREIGN KEY (product_id, lot_id)
    REFERENCES product_lots (product_id, id),
  CONSTRAINT ck_stock_movement_locations_present
    CHECK (from_location_id IS NOT NULL OR to_location_id IS NOT NULL),
  CONSTRAINT ck_stock_movement_locations_not_equal
    CHECK (from_location_id IS NULL OR to_location_id IS NULL OR from_location_id <> to_location_id),
  CONSTRAINT ck_stock_movement_type_required_locations
    CHECK (
      (movement_type = 'RECEIVE' AND to_location_id IS NOT NULL)
      OR (movement_type = 'TRANSFER_OUT' AND from_location_id IS NOT NULL)
      OR (movement_type = 'TRANSFER_IN' AND to_location_id IS NOT NULL)
      OR (movement_type = 'DISPENSE' AND from_location_id IS NOT NULL)
      OR (movement_type = 'ADJUST')
    )
);

CREATE TABLE IF NOT EXISTS stock_on_hand (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES locations (id),
  product_id uuid NOT NULL REFERENCES products (id),
  lot_id uuid REFERENCES product_lots (id),
  base_unit_level_id uuid NOT NULL REFERENCES product_unit_levels (id),
  quantity_on_hand numeric(14,3) NOT NULL CHECK (quantity_on_hand >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_stock_on_hand_product_unit_level
    FOREIGN KEY (product_id, base_unit_level_id)
    REFERENCES product_unit_levels (product_id, id),
  CONSTRAINT fk_stock_on_hand_product_lot
    FOREIGN KEY (product_id, lot_id)
    REFERENCES product_lots (product_id, id),
  CONSTRAINT uq_stock_on_hand UNIQUE (branch_id, product_id, lot_id, base_unit_level_id)
);

CREATE TABLE IF NOT EXISTS dispensing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_name varchar(120) NOT NULL UNIQUE,
  rule_scope rule_scope NOT NULL DEFAULT 'DOSAGE_FORM_GROUP',
  dosage_form_group dosage_form_group,
  product_category_id uuid REFERENCES product_categories (id),
  product_id uuid REFERENCES products (id),
  max_qty numeric(12,3) NOT NULL CHECK (max_qty > 0),
  unit_type_id uuid NOT NULL REFERENCES unit_types (id),
  rule_period rule_period NOT NULL DEFAULT 'PER_VISIT',
  priority smallint NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  valid_from date NOT NULL DEFAULT CURRENT_DATE,
  valid_to date,
  note_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_dispensing_rule_scope_target
    CHECK (
      (rule_scope = 'DOSAGE_FORM_GROUP' AND dosage_form_group IS NOT NULL AND product_category_id IS NULL AND product_id IS NULL)
      OR (rule_scope = 'PRODUCT_CATEGORY' AND dosage_form_group IS NULL AND product_category_id IS NOT NULL AND product_id IS NULL)
      OR (rule_scope = 'PRODUCT' AND dosage_form_group IS NULL AND product_category_id IS NULL AND product_id IS NOT NULL)
    ),
  CONSTRAINT ck_dispensing_rule_dates CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_unit_levels_one_base
  ON product_unit_levels (product_id)
  WHERE is_base;

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_unit_levels_barcode
  ON product_unit_levels (barcode)
  WHERE barcode IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_on_hand_branch_product_lot_unit
  ON stock_on_hand (
    branch_id,
    product_id,
    COALESCE(lot_id, '00000000-0000-0000-0000-000000000000'::uuid),
    base_unit_level_id
  );

CREATE INDEX IF NOT EXISTS idx_patients_pid ON patients (pid);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product_occurred_at
  ON stock_movements (product_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_from_location_occurred_at
  ON stock_movements (from_location_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_to_location_occurred_at
  ON stock_movements (to_location_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_on_hand_branch_product
  ON stock_on_hand (branch_id, product_id);
CREATE INDEX IF NOT EXISTS idx_dispense_headers_patient_dispensed_at
  ON dispense_headers (patient_id, dispensed_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispense_lines_header_id
  ON dispense_lines (header_id);

COMMENT ON TABLE locations IS 'ตารางสถานที่ทั้งหมด: สาขา, สำนักงาน, ผู้ผลิต, ผู้ค้าส่ง ฯลฯ';
COMMENT ON TABLE users IS 'ผู้ใช้งานระบบพร้อมบทบาทและข้อมูลลายเซ็นอิเล็กทรอนิกส์';
COMMENT ON TABLE patients IS 'ข้อมูลผู้ป่วยสำหรับบันทึก ขย 10/11';
COMMENT ON TABLE products IS 'ข้อมูลสินค้ายา (ชื่อการค้า) และเมทาดาต้าหลัก';
COMMENT ON TABLE product_ingredients IS 'องค์ประกอบตัวยาแบบหลายสาร (many-to-many พร้อมความแรงแบบโครงสร้าง)';
COMMENT ON TABLE product_unit_levels IS 'ระดับหน่วยบรรจุ/ขายของสินค้า เช่น เม็ด, แผง, กล่อง, ขวด';
COMMENT ON TABLE product_unit_conversions IS 'ความสัมพันธ์แพ็กเกจ: 1 หน่วยแม่ = multiplier หน่วยลูก';
COMMENT ON TABLE product_lots IS 'ข้อมูลล็อตยาเพื่อรองรับการติดตามตาม lot_no และวันหมดอายุ';
COMMENT ON TABLE stock_movements IS 'สมุดบัญชีการเคลื่อนไหวสต็อก (ledger) ระดับเหตุการณ์';
COMMENT ON TABLE stock_on_hand IS 'สรุปสต็อกคงเหลือแบบเร็วต่อสาขา/สินค้า/ล็อต';
COMMENT ON TABLE dispense_headers IS 'หัวบิลการจ่ายยา (visit) สำหรับ ขย 10/11';
COMMENT ON TABLE dispense_lines IS 'รายการยาที่จ่ายในแต่ละ visit';
COMMENT ON TABLE dispensing_rules IS 'กติกาจำกัดปริมาณการจ่ายยา (ปรับเพิ่มได้ในอนาคต)';

COMMENT ON COLUMN product_ingredients.strength_numerator IS 'ค่าความแรงตัวตั้ง เช่น 125 ใน 125 mg/5 mL';
COMMENT ON COLUMN product_ingredients.numerator_unit_id IS 'หน่วยตัวตั้งของความแรง เช่น mg, mcg';
COMMENT ON COLUMN product_ingredients.strength_denominator IS 'ค่าตัวหารของความแรง เช่น 5 ใน 125 mg/5 mL';
COMMENT ON COLUMN product_ingredients.denominator_unit_id IS 'หน่วยตัวหารของความแรง เช่น mL';
COMMENT ON COLUMN product_unit_conversions.multiplier IS 'ตัวคูณแปลงหน่วย: 1 parent = multiplier child';
COMMENT ON COLUMN stock_movements.unit_level_id IS 'หน่วยที่ใช้บันทึกการเคลื่อนไหวจริง (แผง/ขวด/เม็ด ฯลฯ)';
COMMENT ON COLUMN stock_movements.from_location_id IS 'ต้นทางการเคลื่อนไหว';
COMMENT ON COLUMN stock_movements.to_location_id IS 'ปลายทางการเคลื่อนไหว';
COMMENT ON COLUMN dispense_headers.signature_hash IS 'ค่า hash อ้างอิงลายเซ็นอิเล็กทรอนิกส์ของเภสัชกร';
COMMENT ON COLUMN dispense_headers.branch_id IS 'สาขาที่ทำรายการจ่ายยา';
COMMENT ON COLUMN stock_on_hand.branch_id IS 'สาขาที่ถือครองสต็อก';

COMMIT;
