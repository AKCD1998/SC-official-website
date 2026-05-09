CREATE TABLE IF NOT EXISTS part_time_pharmacists (
  license_id_number BIGINT PRIMARY KEY CHECK (license_id_number > 0),
  pharmacist_title TEXT NOT NULL,
  pharmacist_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_set_part_time_pharmacists_updated_at ON part_time_pharmacists;
CREATE TRIGGER trg_set_part_time_pharmacists_updated_at
BEFORE UPDATE ON part_time_pharmacists
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
