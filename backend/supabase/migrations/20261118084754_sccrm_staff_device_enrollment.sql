CREATE TABLE sccrm_fleet.staff_device_access (
  node_id text PRIMARY KEY REFERENCES sccrm_fleet.nodes(node_id),
  staff_device_id uuid UNIQUE REFERENCES public.staff_devices(id),
  approved_at timestamptz,
  approved_by text,
  pending_device_id text,
  code_hash text UNIQUE CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  code_expires_at timestamptz,
  issued_by text,
  last_revoked_at timestamptz,
  last_revoked_by text,
  CHECK ((approved_at IS NULL) = (approved_by IS NULL)),
  CHECK (approved_at IS NULL OR staff_device_id IS NOT NULL),
  CHECK ((code_hash IS NULL) = (code_expires_at IS NULL)
     AND (code_hash IS NULL) = (pending_device_id IS NULL)
     AND (code_hash IS NULL) = (issued_by IS NULL)),
  CHECK ((last_revoked_at IS NULL) = (last_revoked_by IS NULL))
);

ALTER TABLE sccrm_fleet.staff_device_access ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sccrm_fleet.staff_device_access FROM PUBLIC, anon, authenticated;
