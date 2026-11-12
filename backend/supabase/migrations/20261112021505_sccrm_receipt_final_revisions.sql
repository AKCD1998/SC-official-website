-- Append-only correction evidence; old native operations and their payloads
-- remain immutable. Only an operator with the existing private DB role can
-- adopt a verified, finalized source receipt. No browser/worker write grant.
SET lock_timeout='2s';
ALTER TABLE sccrm_receipt_sync.native_deliveries ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE sccrm_receipt_sync.native_deliveries DROP CONSTRAINT native_deliveries_parent_id_target_branch_key;
ALTER TABLE sccrm_receipt_sync.native_deliveries ADD UNIQUE(parent_id,target_branch,revision);
CREATE TABLE sccrm_receipt_sync.final_revisions(
 claim_id text NOT NULL REFERENCES public.loyalty_claims(id),revision integer NOT NULL CHECK(revision>1),
 job_id uuid NOT NULL REFERENCES sccrm_receipt_sync.jobs(id),member_id uuid NOT NULL REFERENCES public.users(id),
 branch_code text NOT NULL,pos_code text NOT NULL,receipt_no text NOT NULL,
 original_claim jsonb NOT NULL,original_items jsonb NOT NULL,original_mirror jsonb NOT NULL,
 final_snapshot jsonb NOT NULL,native_proof jsonb NOT NULL,packet_hash char(64) NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(claim_id,revision)
);
ALTER TABLE sccrm_receipt_sync.final_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sccrm_receipt_sync.final_revisions FROM PUBLIC;
DO $$ DECLARE actor text; BEGIN
 FOREACH actor IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=actor) THEN
   EXECUTE format('REVOKE ALL ON sccrm_receipt_sync.final_revisions FROM %I',actor);
  END IF;
 END LOOP;
END $$;
CREATE TRIGGER keep_final_revisions BEFORE UPDATE OR DELETE ON sccrm_receipt_sync.final_revisions
 FOR EACH ROW EXECUTE FUNCTION sccrm_receipt_sync.keep_events();
CREATE OR REPLACE FUNCTION sccrm_receipt_sync.keep_native_identity() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF ROW(NEW.id,NEW.parent_id,NEW.target_branch,NEW.payload,NEW.payload_hash,NEW.created_at,NEW.revision)
  IS DISTINCT FROM ROW(OLD.id,OLD.parent_id,OLD.target_branch,OLD.payload,OLD.payload_hash,OLD.created_at,OLD.revision)
 THEN RAISE EXCEPTION 'NATIVE_RECEIPT_IDENTITY_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
