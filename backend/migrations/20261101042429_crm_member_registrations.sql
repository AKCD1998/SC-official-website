-- Generated with `supabase migration new crm_member_registrations` and placed
-- in this application's explicit CRM migration directory. Apply ONLY through
-- provision-member-registration-reporting.cjs; no historical backfill.
CREATE SCHEMA IF NOT EXISTS crm_reporting;
REVOKE ALL ON SCHEMA crm_reporting FROM PUBLIC;

CREATE TABLE IF NOT EXISTS crm_reporting.member_registrations (
  -- Deliberately independent of later account consolidation/deletion.
  -- This records a signup event, never a mirror/import or a current profile.
  member_id uuid PRIMARY KEY,
  registered_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('pos', 'counter', 'staff', 'app', 'qr')),
  branch_code text CHECK (branch_code IN ('001', '003', '004', '005')),
  device_id text
);
CREATE INDEX IF NOT EXISTS member_registrations_registered_at_idx
  ON crm_reporting.member_registrations (registered_at, branch_code);
CREATE TABLE IF NOT EXISTS crm_reporting.registration_tracking (
  id integer PRIMARY KEY CHECK (id = 1),
  -- Activated explicitly AFTER the new registration writers are deployed.
  tracking_started_at timestamptz
);
INSERT INTO crm_reporting.registration_tracking (id) VALUES (1) ON CONFLICT DO NOTHING;
ALTER TABLE crm_reporting.member_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_reporting.registration_tracking ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA crm_reporting FROM PUBLIC;
DO $$ DECLARE browser_role text; BEGIN
  FOREACH browser_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = browser_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA crm_reporting FROM %I', browser_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA crm_reporting FROM %I', browser_role);
    END IF;
  END LOOP;
END $$;
INSERT INTO public.crm_counter_schema_migrations (filename)
VALUES ('20261101042429_crm_member_registrations.sql') ON CONFLICT DO NOTHING;
