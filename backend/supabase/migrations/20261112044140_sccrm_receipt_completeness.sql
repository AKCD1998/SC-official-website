-- Additive private completeness queue. It never creates a native sale or points.
SET lock_timeout='2s';
CREATE TABLE sccrm_receipt_sync.completeness_control(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 marker uuid NOT NULL,enabled boolean NOT NULL DEFAULT false,pilot_claims text[]);
INSERT INTO sccrm_receipt_sync.completeness_control(singleton,marker)VALUES(true,'ba30ffae-036c-4b7c-a276-8eb8f5474768');
CREATE TABLE sccrm_receipt_sync.completeness(
 claim_id text PRIMARY KEY REFERENCES public.loyalty_claims(id),job_id uuid NOT NULL UNIQUE REFERENCES sccrm_receipt_sync.jobs(id),
 origin_branch text NOT NULL CHECK(origin_branch IN('001','003','004','005')),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','running','retry','review','verified')),
 code text NOT NULL DEFAULT 'RECON_PENDING',attempts integer NOT NULL DEFAULT 0,
 next_check_at timestamptz NOT NULL DEFAULT now(),lease_token uuid,lease_until timestamptz,baseline_hash char(64),
 verified_at timestamptz,evidence jsonb NOT NULL DEFAULT '{}'::jsonb,last_token uuid,last_ack_hash char(64),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((state='running')=(lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX completeness_due ON sccrm_receipt_sync.completeness(origin_branch,next_check_at) WHERE state<>'review';
CREATE TABLE sccrm_receipt_sync.completeness_audit(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,claim_id text NOT NULL REFERENCES public.loyalty_claims(id),
 code text NOT NULL,before_hash char(64) NOT NULL,after_hash char(64) NOT NULL,
 original_snapshot jsonb NOT NULL,final_snapshot jsonb NOT NULL,proof jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER completeness_audit_immutable BEFORE UPDATE OR DELETE ON sccrm_receipt_sync.completeness_audit
 FOR EACH ROW EXECUTE FUNCTION sccrm_receipt_sync.keep_events();
ALTER TABLE sccrm_receipt_sync.completeness ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_receipt_sync.completeness_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_receipt_sync.completeness_control ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sccrm_receipt_sync.completeness,sccrm_receipt_sync.completeness_audit,sccrm_receipt_sync.completeness_control FROM PUBLIC;
DO $$ DECLARE actor text; BEGIN FOREACH actor IN ARRAY ARRAY['anon','authenticated'] LOOP
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=actor) THEN
  EXECUTE format('REVOKE ALL ON sccrm_receipt_sync.completeness,sccrm_receipt_sync.completeness_audit,sccrm_receipt_sync.completeness_control FROM %I',actor);
 END IF;END LOOP;END $$;
INSERT INTO sccrm_receipt_sync.jobs(id,kind,reference_id,member_id,claim_id,origin_branch,origin_pos,state,last_code)
 SELECT gen_random_uuid(),'receipt',lc.id,lc.user_id::uuid,lc.id,lc.branch_code,lc.receipt_snapshot->>'posCode','review','RECON_WAITING_INITIAL_AUDIT'
 FROM public.loyalty_claims lc WHERE lc.branch_code IN('001','003','004','005') AND lc.receipt_snapshot->>'posCode' IN('001','002')
  AND lc.receipt_no ~ '^S[0-9]{10}-[0-9]+$' AND substring(lc.receipt_no from 6 for 3)=lc.branch_code
  AND substring(lc.receipt_no from 9 for 3)=lc.receipt_snapshot->>'posCode'
 ON CONFLICT(kind,reference_id) DO NOTHING;
INSERT INTO sccrm_receipt_sync.completeness(claim_id,job_id,origin_branch)
 SELECT claim_id,id,origin_branch FROM sccrm_receipt_sync.jobs WHERE kind='receipt' AND claim_id IS NOT NULL;
