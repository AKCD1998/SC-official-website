BEGIN;

-- Review-only persistence contract for Shopee -> AdaSmart Branch 004. This migration creates
-- no worker, transport, UI automation, credential, navigation, input, or Save capability.
CREATE TABLE IF NOT EXISTS adasmart_shopee_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  processing_record_id uuid NOT NULL REFERENCES processing_records(id) ON DELETE RESTRICT,
  upload_id uuid NOT NULL REFERENCES workbook_uploads(id) ON DELETE RESTRICT,
  source_file_id uuid NOT NULL REFERENCES generated_files(id) ON DELETE RESTRICT,
  source_checksum_sha256 char(64) NOT NULL
    CHECK (source_checksum_sha256 ~ '^[a-f0-9]{64}$'),
  plan_digest char(64) NOT NULL CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
  branch_code char(3) NOT NULL CHECK (branch_code = '004'),
  shop_code text NOT NULL CHECK (shop_code IN ('sc-drug-store', 'dr-morepen')),
  order_number text NOT NULL CHECK (order_number ~ '^[A-Z0-9]{8,40}$'),
  document_type text NOT NULL CHECK (document_type = 'standard_credit_quotation'),
  cycle_key text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL CHECK (period_end >= period_start),
  cycle_contract_revision text NOT NULL,
  product_catalog_version text NOT NULL,
  product_catalog_digest char(64) NOT NULL
    CHECK (product_catalog_digest ~ '^[a-f0-9]{64}$'),
  erp_source_checksum char(64) NOT NULL CHECK (erp_source_checksum ~ '^[a-f0-9]{64}$'),
  customer_policy_key text NOT NULL CHECK (char_length(customer_policy_key) BETWEEN 1 AND 160),
  customer_code text NOT NULL CHECK (char_length(customer_code) BETWEEN 1 AND 100),
  customer_policy_revision text NOT NULL
    CHECK (char_length(customer_policy_revision) BETWEEN 1 AND 160),
  confirmed_by text NOT NULL CHECK (char_length(confirmed_by) BETWEEN 1 AND 128),
  confirmation_auth_source text NOT NULL CHECK (confirmation_auth_source IN ('session', 'admin_basic')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  current_status text NOT NULL CHECK (current_status IN (
    'draft',
    'confirmed',
    'queued_dry_run',
    'dry_run_completed',
    'blocked',
    'cancelled'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_code, shop_code, order_number, document_type)
);

COMMENT ON TABLE adasmart_shopee_jobs IS 'Feature-gated immutable AdaSmart dry-run jobs. No row authorizes UI navigation, input, Save, or direct AdaAcc writes.';
COMMENT ON COLUMN adasmart_shopee_jobs.payload IS 'PII-free validated effects only: Company SKU, positive integer quantity, and one unambiguous barcode.';

CREATE INDEX IF NOT EXISTS idx_adasmart_shopee_jobs_status_created
  ON adasmart_shopee_jobs (current_status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_adasmart_shopee_jobs_processing_record
  ON adasmart_shopee_jobs (processing_record_id, created_at ASC);

CREATE TABLE IF NOT EXISTS adasmart_shopee_job_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES adasmart_shopee_jobs(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN (
    'draft',
    'confirmed',
    'queued_dry_run',
    'dry_run_completed',
    'blocked',
    'cancelled'
  )),
  actor text NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 128),
  auth_source text NOT NULL CHECK (auth_source IN ('session', 'admin_basic', 'internal_worker')),
  CHECK (status <> 'confirmed' OR auth_source IN ('session', 'admin_basic')),
  reason_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, status)
);

COMMENT ON TABLE adasmart_shopee_job_events IS 'Append-only status history for dry-run jobs; metadata must remain bounded and PII-free.';

CREATE INDEX IF NOT EXISTS idx_adasmart_shopee_job_events_job_created
  ON adasmart_shopee_job_events (job_id, created_at ASC);

CREATE OR REPLACE FUNCTION prevent_adasmart_shopee_job_core_change()
RETURNS trigger AS $$
BEGIN
  IF NEW.processing_record_id IS DISTINCT FROM OLD.processing_record_id
    OR NEW.upload_id IS DISTINCT FROM OLD.upload_id
    OR NEW.source_file_id IS DISTINCT FROM OLD.source_file_id
    OR NEW.source_checksum_sha256 IS DISTINCT FROM OLD.source_checksum_sha256
    OR NEW.plan_digest IS DISTINCT FROM OLD.plan_digest
    OR NEW.branch_code IS DISTINCT FROM OLD.branch_code
    OR NEW.shop_code IS DISTINCT FROM OLD.shop_code
    OR NEW.order_number IS DISTINCT FROM OLD.order_number
    OR NEW.document_type IS DISTINCT FROM OLD.document_type
    OR NEW.cycle_key IS DISTINCT FROM OLD.cycle_key
    OR NEW.period_start IS DISTINCT FROM OLD.period_start
    OR NEW.period_end IS DISTINCT FROM OLD.period_end
    OR NEW.cycle_contract_revision IS DISTINCT FROM OLD.cycle_contract_revision
    OR NEW.product_catalog_version IS DISTINCT FROM OLD.product_catalog_version
    OR NEW.product_catalog_digest IS DISTINCT FROM OLD.product_catalog_digest
    OR NEW.erp_source_checksum IS DISTINCT FROM OLD.erp_source_checksum
    OR NEW.customer_policy_key IS DISTINCT FROM OLD.customer_policy_key
    OR NEW.customer_code IS DISTINCT FROM OLD.customer_code
    OR NEW.customer_policy_revision IS DISTINCT FROM OLD.customer_policy_revision
    OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
    OR NEW.confirmation_auth_source IS DISTINCT FROM OLD.confirmation_auth_source
    OR NEW.payload IS DISTINCT FROM OLD.payload
  THEN
    RAISE EXCEPTION 'AdaSmart Shopee job core fields are immutable';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_adasmart_shopee_jobs_immutable_core ON adasmart_shopee_jobs;
CREATE TRIGGER trg_adasmart_shopee_jobs_immutable_core
BEFORE UPDATE ON adasmart_shopee_jobs
FOR EACH ROW EXECUTE FUNCTION prevent_adasmart_shopee_job_core_change();

CREATE OR REPLACE FUNCTION reject_adasmart_shopee_job_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AdaSmart Shopee jobs and events are immutable; use cancelled status';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_adasmart_shopee_jobs_no_delete ON adasmart_shopee_jobs;
CREATE TRIGGER trg_adasmart_shopee_jobs_no_delete
BEFORE DELETE ON adasmart_shopee_jobs
FOR EACH ROW EXECUTE FUNCTION reject_adasmart_shopee_job_delete();

DROP TRIGGER IF EXISTS trg_adasmart_shopee_job_events_no_update ON adasmart_shopee_job_events;
CREATE TRIGGER trg_adasmart_shopee_job_events_no_update
BEFORE UPDATE OR DELETE ON adasmart_shopee_job_events
FOR EACH ROW EXECUTE FUNCTION reject_adasmart_shopee_job_delete();

COMMIT;
