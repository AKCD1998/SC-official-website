-- Additive, separately provisioned customer-portal storage; no member/bill changes.
CREATE TABLE public.member_portal_email_otps (
 id uuid PRIMARY KEY, email_hash char(64) NOT NULL, ip_hash char(64) NOT NULL,
 code_hash char(64) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL, delivered_at timestamptz,
 used_at timestamptz, attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5)
);
CREATE INDEX member_portal_otp_email_time ON public.member_portal_email_otps(email_hash,created_at DESC);
CREATE INDEX member_portal_otp_ip_time ON public.member_portal_email_otps(ip_hash,created_at DESC);
CREATE INDEX member_portal_otp_time ON public.member_portal_email_otps(created_at DESC);
CREATE TABLE public.member_portal_sessions (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 token_hash char(64) NOT NULL UNIQUE, email_hash char(64) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 last_seen_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
CREATE INDEX member_portal_session_user ON public.member_portal_sessions(user_id);
CREATE INDEX member_portal_session_expiry ON public.member_portal_sessions(expires_at);
ALTER TABLE public.member_portal_email_otps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_portal_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_portal_email_otps, public.member_portal_sessions FROM PUBLIC;
DO $$ DECLARE browser_role text; BEGIN
 FOREACH browser_role IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=browser_role) THEN
   EXECUTE format('REVOKE ALL ON public.member_portal_email_otps, public.member_portal_sessions FROM %I',browser_role);
  END IF;
 END LOOP;
END $$;
INSERT INTO public.crm_counter_schema_migrations(filename) VALUES('202610240001_member_portal_email_auth.sql');
