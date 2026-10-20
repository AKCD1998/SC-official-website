-- Explicit counter-registration bootstrap only. Never run by the Seamless runner
-- or knex migrate:latest. See scripts/provision-crm-counter.cjs.
-- The operator must verify that this is the intended, empty CRM trial database.

CREATE TABLE IF NOT EXISTS public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  phone_number varchar(30),
  email varchar(255),
  password_hash text,
  is_verified boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  dob date,
  sex varchar(20),
  remark text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_counter_users_phone_unique
  ON public.users (phone_number) WHERE phone_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS crm_counter_users_email_unique
  ON public.users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(100) NOT NULL,
  code varchar(20) NOT NULL UNIQUE,
  address text,
  phone varchar(20),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.staff_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id varchar(255) NOT NULL UNIQUE,
  device_name varchar(255) NOT NULL,
  token_hash varchar(255) NOT NULL UNIQUE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_counter_staff_branch_idx
  ON public.staff_devices (branch_id);

CREATE TABLE IF NOT EXISTS public.member_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  member_code varchar(50) NOT NULL UNIQUE,
  tier varchar(20) NOT NULL DEFAULT 'bronze'
    CHECK (tier IN ('bronze', 'silver', 'gold')),
  is_active boolean NOT NULL DEFAULT true,
  remark text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.crm_member_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  consent_version varchar(20) NOT NULL DEFAULT 'v1.0',
  pdpa_general boolean NOT NULL DEFAULT false,
  pdpa_health boolean NOT NULL DEFAULT false,
  marketing_email boolean NOT NULL DEFAULT false,
  marketing_sms boolean NOT NULL DEFAULT false,
  consented_at timestamptz NOT NULL DEFAULT now(),
  recorded_by_device_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_counter_consents_user_idx
  ON public.crm_member_consents (user_id);

CREATE TABLE IF NOT EXISTS public.crm_member_health_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  pid_document_type varchar(20),
  pid_document_number text,
  has_diabetes boolean NOT NULL DEFAULT false,
  has_hypertension boolean NOT NULL DEFAULT false,
  has_hyperlipidemia boolean NOT NULL DEFAULT false,
  has_heart_disease boolean NOT NULL DEFAULT false,
  has_kidney_disease boolean NOT NULL DEFAULT false,
  has_liver_disease boolean NOT NULL DEFAULT false,
  has_thyroid_disease boolean NOT NULL DEFAULT false,
  other_conditions text,
  drug_allergies text,
  current_medications text,
  recorded_by_device_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.crm_counter_schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- The existing server connects as the table owner. Browser/Data API roles must
-- not gain direct access through Supabase's default public-schema grants.
DO $$
DECLARE relation_name text; browser_role text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'users', 'branches', 'staff_devices', 'member_profiles',
    'crm_member_consents', 'crm_member_health_records',
    'crm_counter_schema_migrations'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', relation_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', relation_name);
    FOREACH browser_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = browser_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', relation_name, browser_role);
      END IF;
    END LOOP;
  END LOOP;
END $$;

INSERT INTO public.crm_counter_schema_migrations (filename)
VALUES ('202610200001_crm_counter_bootstrap.sql')
ON CONFLICT (filename) DO NOTHING;
