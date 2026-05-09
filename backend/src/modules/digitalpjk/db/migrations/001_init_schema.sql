CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION set_branch_location_text_default()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.location_text IS NULL OR BTRIM(NEW.location_text) = '' THEN
    NEW.location_text = COALESCE(
      NULLIF(BTRIM(NEW.province), ''),
      NULLIF(BTRIM(NEW.district), '')
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_code TEXT NOT NULL UNIQUE,
  pharmacy_name_th TEXT NOT NULL,
  branch_name_th TEXT NOT NULL,
  address_no TEXT,
  soi TEXT,
  district TEXT,
  province TEXT,
  postcode TEXT,
  phone TEXT,
  license_no TEXT,
  location_text TEXT,
  operator_title TEXT,
  operator_work_hours TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  branch_id UUID NOT NULL REFERENCES branches(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  display_name_th TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS global_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  use_system_date BOOLEAN NOT NULL DEFAULT TRUE,
  forced_date DATE,
  updated_by UUID REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_branch_id ON users(branch_id);

DROP TRIGGER IF EXISTS trg_set_branches_updated_at ON branches;
CREATE TRIGGER trg_set_branches_updated_at
BEFORE UPDATE ON branches
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_set_users_updated_at ON users;
CREATE TRIGGER trg_set_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_set_global_settings_updated_at ON global_settings;
CREATE TRIGGER trg_set_global_settings_updated_at
BEFORE UPDATE ON global_settings
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_set_branch_location_text_default ON branches;
CREATE TRIGGER trg_set_branch_location_text_default
BEFORE INSERT OR UPDATE ON branches
FOR EACH ROW
EXECUTE FUNCTION set_branch_location_text_default();
