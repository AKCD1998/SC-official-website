SET lock_timeout = '2s';
SET statement_timeout = '20s';

ALTER TABLE public.member_profiles ADD COLUMN IF NOT EXISTS contact_phone varchar(10);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.member_profiles'::regclass AND conname='member_contact_mobile_format') THEN
    ALTER TABLE public.member_profiles ADD CONSTRAINT member_contact_mobile_format
      CHECK(contact_phone IS NULL OR contact_phone ~ '^0[689][0-9]{8}$');
  END IF;
END $$;

DO $$ DECLARE owned_check text; BEGIN
  IF to_regclass('sccrm_member_codes.assignments') IS NOT NULL THEN
    IF to_regclass('sccrm_member_codes.meta') IS NULL OR NOT EXISTS(
      SELECT 1 FROM sccrm_member_codes.meta WHERE singleton=true
        AND marker='cffb05d6-116a-458d-98ba-52473745c116'::uuid
        AND scope='SCCRM-HQ-MEMBER-CODE-AUTHORITY-V1' AND schema_version=1
    ) THEN RAISE EXCEPTION 'REGISTRATION_CODE_SCHEMA_NOT_OWNED'; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='sccrm_member_codes.assignments'::regclass AND conname='registration_assignment_kind') THEN
      ALTER TABLE sccrm_member_codes.assignments ADD CONSTRAINT registration_assignment_kind
        CHECK(kind IN('hq_create','hq_create_distinct','approved_existing'));
    END IF;
    FOR owned_check IN SELECT conname FROM pg_constraint
      WHERE conrelid='sccrm_member_codes.assignments'::regclass AND contype='c'
        AND conname<>'registration_assignment_kind' AND array_length(conkey,1)=1
        AND pg_get_constraintdef(oid) LIKE '%kind%' AND pg_get_constraintdef(oid) LIKE '%hq_create%'
    LOOP EXECUTE format('ALTER TABLE sccrm_member_codes.assignments DROP CONSTRAINT %I',owned_check); END LOOP;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='sccrm_member_codes.assignments'::regclass AND conname='registration_hq_created_code') THEN
      ALTER TABLE sccrm_member_codes.assignments ADD CONSTRAINT registration_hq_created_code
        CHECK(kind NOT IN('hq_create','hq_create_distinct') OR ada_code ~ '^AR000-[0-9]{6}$');
    END IF;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS member_profiles_contact_phone ON public.member_profiles(contact_phone) WHERE contact_phone IS NOT NULL;

CREATE SCHEMA IF NOT EXISTS sccrm_registration;
REVOKE ALL ON SCHEMA sccrm_registration FROM PUBLIC;
CREATE TABLE IF NOT EXISTS sccrm_registration.confirmations (
  request_id uuid PRIMARY KEY,
  staff_device_id uuid NOT NULL REFERENCES public.staff_devices(id),
  member_id uuid NOT NULL REFERENCES public.users(id),
  action text NOT NULL CHECK(action IN('existing','new')),
  contact_phone varchar(10) NOT NULL CHECK(contact_phone ~ '^0[689][0-9]{8}$'),
  request_hash char(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  draft_hash char(64) NOT NULL CHECK(draft_hash ~ '^[a-f0-9]{64}$'),
  profile_hash char(64) NOT NULL CHECK(profile_hash ~ '^[a-f0-9]{64}$'),
  allow_shared_contact boolean NOT NULL DEFAULT false,
  previous_code varchar(50),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  CHECK(NOT allow_shared_contact OR action='new')
);
CREATE INDEX IF NOT EXISTS registration_confirmation_member ON sccrm_registration.confirmations(member_id);
CREATE INDEX IF NOT EXISTS registration_confirmation_staff ON sccrm_registration.confirmations(staff_device_id);
CREATE UNIQUE INDEX IF NOT EXISTS registration_previous_code ON sccrm_registration.confirmations(previous_code) WHERE previous_code IS NOT NULL;
ALTER TABLE sccrm_registration.confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sccrm_registration.confirmations FROM PUBLIC;
DO $$ DECLARE browser_role text; BEGIN
  FOREACH browser_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=browser_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA sccrm_registration FROM %I',browser_role);
      EXECUTE format('REVOKE ALL ON sccrm_registration.confirmations FROM %I',browser_role);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sccrm_hq_live_sync') THEN
    GRANT USAGE ON SCHEMA sccrm_registration TO sccrm_hq_live_sync;
    GRANT SELECT ON sccrm_registration.confirmations TO sccrm_hq_live_sync;
    GRANT SELECT(contact_phone) ON public.member_profiles TO sccrm_hq_live_sync;
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='sccrm_registration' AND tablename='confirmations' AND policyname='hq_read_registration_confirmations') THEN
      CREATE POLICY hq_read_registration_confirmations ON sccrm_registration.confirmations FOR SELECT TO sccrm_hq_live_sync USING(true);
    END IF;
  END IF;
END $$;

CREATE OR REPLACE VIEW ada_history.directory AS
 SELECT u.id,u.full_name,COALESCE(u.phone_number,m.contact_phone,a.phone) phone_number,
   m.member_code,m.is_active,m.created_at,'sccrm'::text source
 FROM public.users u JOIN public.member_profiles m ON m.user_id=u.id
 LEFT JOIN LATERAL(SELECT c.phone FROM ada_history.member_links l
   JOIN ada_history.customers c ON c.source_id=l.source_id AND c.ada_code=l.ada_code
   WHERE l.member_id=u.id ORDER BY (NULLIF(btrim(c.phone),'') IS NULL),
     CASE WHEN c.ada_code=m.member_code THEN 0 ELSE 1 END,c.ada_code LIMIT 1) a ON true
 UNION ALL
 SELECT c.directory_id,c.name,c.phone,'ADA-'||c.ada_code,c.active='1',c.updated_at,'ada'::text
 FROM ada_history.customers c WHERE NOT EXISTS(SELECT 1 FROM ada_history.member_links l WHERE l.source_id=c.source_id AND l.ada_code=c.ada_code);
