BEGIN;
SET LOCAL lock_timeout='2s';
DO $$ BEGIN
 IF to_regnamespace('sccrm_preorders') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='sccrm_preorders' AND table_name='meta') THEN RAISE EXCEPTION 'PREORDER_SCHEMA_NOT_OWNED';END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS sccrm_preorders;
CREATE TABLE IF NOT EXISTS sccrm_preorders.meta(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),marker uuid NOT NULL,version integer NOT NULL,enabled boolean NOT NULL DEFAULT false);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sccrm_preorders.meta WHERE marker<>'96718ac4-8e3c-4d5c-851d-1f4bd6c26015' OR version<>1) THEN RAISE EXCEPTION 'PREORDER_SCHEMA_NOT_OWNED';END IF;
END $$;
INSERT INTO sccrm_preorders.meta VALUES(true,'96718ac4-8e3c-4d5c-851d-1f4bd6c26015',1,false) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS sccrm_preorders.histories(
 id uuid PRIMARY KEY,member_id uuid NOT NULL REFERENCES public.users(id),version integer NOT NULL CHECK(version>0),
 source_kind text NOT NULL CHECK(source_kind IN('staff_note','paper_import')),source_reference text NOT NULL,source_row integer,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND jsonb_typeof(payload->'items')='array' AND jsonb_array_length(payload->'items') BETWEEN 1 AND 40),
 created_by_device text NOT NULL,updated_by_device text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS member_preorder_history_member ON sccrm_preorders.histories(member_id,created_at,id);
CREATE UNIQUE INDEX IF NOT EXISTS member_preorder_paper_once ON sccrm_preorders.histories(member_id,source_reference,source_row) WHERE source_kind='paper_import';
CREATE TABLE IF NOT EXISTS sccrm_preorders.history_versions(
 history_id uuid NOT NULL REFERENCES sccrm_preorders.histories(id),version integer NOT NULL,payload jsonb NOT NULL,recorded_by_device text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(history_id,version)
);
CREATE TABLE IF NOT EXISTS sccrm_preorders.bill_links(
 id uuid PRIMARY KEY,member_id uuid NOT NULL REFERENCES public.users(id),branch_code varchar(3) NOT NULL,receipt_no varchar(100) NOT NULL,
 receipt_fingerprint char(64) NOT NULL,receipt_snapshot jsonb NOT NULL,matched_items jsonb NOT NULL,
 confirmed_by_device text NOT NULL,confirmed_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz,revoked_by_device text,revoke_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS member_preorder_bill_owner ON sccrm_preorders.bill_links(branch_code,receipt_no) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS member_preorder_bill_member ON sccrm_preorders.bill_links(member_id,confirmed_at);
CREATE TABLE IF NOT EXISTS sccrm_preorders.requests(
 request_id uuid PRIMARY KEY,member_id uuid NOT NULL REFERENCES public.users(id),actor_device text NOT NULL,action text NOT NULL,body_hash char(64) NOT NULL,response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sccrm_preorders.events(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,member_id uuid NOT NULL REFERENCES public.users(id),actor_device text NOT NULL,action text NOT NULL,details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sccrm_preorders.meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_preorders.histories ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_preorders.history_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_preorders.bill_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_preorders.requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_preorders.events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON SCHEMA sccrm_preorders FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA sccrm_preorders FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA sccrm_preorders FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
 FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated') LOOP
  EXECUTE format('REVOKE ALL ON SCHEMA sccrm_preorders FROM %I',role_name);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA sccrm_preorders FROM %I',role_name);
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA sccrm_preorders FROM %I',role_name);
 END LOOP;
END $$;
COMMIT;
