-- Private queue consumed by the separately installed HQ receipt worker.
-- The worker can call a dedicated authenticated HTTP capability only; it has
-- no PostgreSQL credentials and cannot change the SCCRM claim or its owner.
SET lock_timeout='2s';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM sccrm_receipt_sync.meta WHERE singleton
  AND marker='9bde36f3-a235-4228-9e6f-190126a213f5' AND schema_version=1)
 THEN RAISE EXCEPTION 'HISTORY_FIRST_SCHEMA_NOT_OWNED'; END IF;
END $$;
ALTER TABLE sccrm_receipt_sync.events ADD COLUMN target_branch char(3)
 CHECK(target_branch IN('000','001','003','004','005'));
CREATE TABLE sccrm_receipt_sync.native_deliveries(
 id uuid PRIMARY KEY,parent_id uuid NOT NULL REFERENCES sccrm_receipt_sync.jobs(id),
 target_branch char(3) NOT NULL CHECK(target_branch IN('000','001','003','004','005')),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 payload_hash char(64) NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','running','retry','review','succeeded')),
 attempt_count integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid,lease_until timestamptz,last_code varchar(80),proof jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(parent_id,target_branch),
 CHECK((state='running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
  OR(state<>'running' AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX native_receipt_due ON sccrm_receipt_sync.native_deliveries(target_branch,next_attempt_at)
 WHERE state IN('pending','retry','running');
CREATE FUNCTION sccrm_receipt_sync.keep_native_identity() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF ROW(NEW.id,NEW.parent_id,NEW.target_branch,NEW.payload,NEW.payload_hash,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.parent_id,OLD.target_branch,OLD.payload,OLD.payload_hash,OLD.created_at)
 THEN RAISE EXCEPTION 'NATIVE_RECEIPT_IDENTITY_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER keep_native_identity BEFORE UPDATE ON sccrm_receipt_sync.native_deliveries
 FOR EACH ROW EXECUTE FUNCTION sccrm_receipt_sync.keep_native_identity();
ALTER TABLE sccrm_receipt_sync.native_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sccrm_receipt_sync.native_deliveries FROM PUBLIC;
REVOKE ALL ON FUNCTION sccrm_receipt_sync.keep_native_identity() FROM PUBLIC;
DO $$ DECLARE actor text; BEGIN
 FOREACH actor IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=actor) THEN
   EXECUTE format('REVOKE ALL ON sccrm_receipt_sync.native_deliveries FROM %I',actor);
  END IF;
 END LOOP;
END $$;
