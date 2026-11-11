-- SCCRM-first receipt/member persistence. Additive private outbox only.
-- No native Ada customer, sale, bill owner, points or public history is rewritten.
SET lock_timeout='2s';
DO $$ BEGIN
 IF to_regnamespace('sccrm_receipt_sync') IS NOT NULL AND
   (to_regclass('sccrm_receipt_sync.meta') IS NULL) THEN
  RAISE EXCEPTION 'HISTORY_FIRST_SCHEMA_NOT_OWNED';
 END IF;
 IF to_regclass('sccrm_receipt_sync.meta') IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM sccrm_receipt_sync.meta WHERE singleton=true
     AND marker='9bde36f3-a235-4228-9e6f-190126a213f5'::uuid
     AND scope='SCCRM-HISTORY-FIRST-V1' AND schema_version=1) THEN
   RAISE EXCEPTION 'HISTORY_FIRST_SCHEMA_NOT_OWNED';
  END IF;
 END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS sccrm_receipt_sync;
REVOKE ALL ON SCHEMA sccrm_receipt_sync FROM PUBLIC;
CREATE TABLE IF NOT EXISTS sccrm_receipt_sync.meta(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),marker uuid NOT NULL,
 scope text NOT NULL,schema_version integer NOT NULL,enabled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO sccrm_receipt_sync.meta(singleton,marker,scope,schema_version)
 VALUES(true,'9bde36f3-a235-4228-9e6f-190126a213f5','SCCRM-HISTORY-FIRST-V1',1)
 ON CONFLICT(singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS sccrm_receipt_sync.jobs(
 id uuid PRIMARY KEY,kind text NOT NULL CHECK(kind IN('member','receipt')),reference_id text NOT NULL,
 member_id uuid NOT NULL REFERENCES public.users(id),claim_id text REFERENCES public.loyalty_claims(id),
 origin_branch text NOT NULL CHECK(origin_branch IN('001','003','004','005')),
 origin_pos text CHECK(origin_pos ~ '^[0-9]{3}$'),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','running','retry','review','succeeded')),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
 next_attempt_at timestamptz NOT NULL DEFAULT now(),lease_token uuid,lease_until timestamptz,
 last_code varchar(80) CHECK(last_code ~ '^[A-Z][A-Z0-9_]{2,79}$'),
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(evidence)='object'),
 manual_retry_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 UNIQUE(kind,reference_id),UNIQUE(claim_id),
 CHECK((kind='member' AND claim_id IS NULL AND reference_id=member_id::text)
    OR(kind='receipt' AND claim_id IS NOT NULL AND reference_id=claim_id)),
 CHECK((state='running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR(state<>'running' AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX IF NOT EXISTS receipt_sync_due ON sccrm_receipt_sync.jobs(next_attempt_at,id)
 WHERE state IN('pending','retry','running');
CREATE INDEX IF NOT EXISTS receipt_sync_branch ON sccrm_receipt_sync.jobs(origin_branch,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS sccrm_receipt_sync.events(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 job_id uuid NOT NULL REFERENCES sccrm_receipt_sync.jobs(id),
 state text NOT NULL CHECK(state IN('pending','running','retry','review','succeeded')),
 code varchar(80) NOT NULL CHECK(code ~ '^[A-Z][A-Z0-9_]{2,79}$'),
 occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS receipt_sync_events_job ON sccrm_receipt_sync.events(job_id,id DESC);
CREATE OR REPLACE FUNCTION sccrm_receipt_sync.keep_job_identity() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF ROW(NEW.id,NEW.kind,NEW.reference_id,NEW.member_id,NEW.claim_id,NEW.origin_branch,NEW.origin_pos,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.kind,OLD.reference_id,OLD.member_id,OLD.claim_id,OLD.origin_branch,OLD.origin_pos,OLD.created_at)
 THEN RAISE EXCEPTION 'SYNC_JOB_IDENTITY_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS keep_job_identity ON sccrm_receipt_sync.jobs;
CREATE TRIGGER keep_job_identity BEFORE UPDATE ON sccrm_receipt_sync.jobs
 FOR EACH ROW EXECUTE FUNCTION sccrm_receipt_sync.keep_job_identity();
CREATE OR REPLACE FUNCTION sccrm_receipt_sync.keep_events() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 RAISE EXCEPTION 'SYNC_AUDIT_IMMUTABLE';
END $$;
DROP TRIGGER IF EXISTS keep_events ON sccrm_receipt_sync.events;
CREATE TRIGGER keep_events BEFORE UPDATE OR DELETE ON sccrm_receipt_sync.events
 FOR EACH ROW EXECUTE FUNCTION sccrm_receipt_sync.keep_events();
ALTER TABLE sccrm_receipt_sync.meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_receipt_sync.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_receipt_sync.events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA sccrm_receipt_sync FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA sccrm_receipt_sync FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sccrm_receipt_sync FROM PUBLIC;
DO $$ DECLARE actor text; BEGIN
 FOREACH actor IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=actor) THEN
   EXECUTE format('REVOKE ALL ON SCHEMA sccrm_receipt_sync FROM %I',actor);
   EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA sccrm_receipt_sync FROM %I',actor);
   EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA sccrm_receipt_sync FROM %I',actor);
   EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sccrm_receipt_sync FROM %I',actor);
  END IF;
 END LOOP;
END $$;
