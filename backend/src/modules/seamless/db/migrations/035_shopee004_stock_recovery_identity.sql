BEGIN;

-- Extend the existing reservation queue; never recreate the opening or its ledger.
ALTER TABLE shopee004_stock_dirty
  ADD COLUMN IF NOT EXISTS recovery_revision bigint,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retry_after timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS recovery_state text NOT NULL DEFAULT 'ready',
  ADD COLUMN IF NOT EXISTS last_error_code text,
  ADD COLUMN IF NOT EXISTS first_failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS exception_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE shopee004_stock_positions
  ADD COLUMN IF NOT EXISTS exception_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE shopee004_stock_dirty DROP CONSTRAINT IF EXISTS shopee004_stock_dirty_recovery_state;
ALTER TABLE shopee004_stock_dirty ADD CONSTRAINT shopee004_stock_dirty_recovery_state
  CHECK (recovery_state IN ('ready','retry_wait','blocked') AND attempt_count >= 0);
CREATE UNIQUE INDEX IF NOT EXISTS shopee004_stock_dirty_exception_id ON shopee004_stock_dirty(exception_id);
CREATE UNIQUE INDEX IF NOT EXISTS shopee004_stock_positions_exception_id ON shopee004_stock_positions(exception_id);
CREATE INDEX IF NOT EXISTS shopee004_stock_dirty_ready ON shopee004_stock_dirty(retry_after,queued_at)
  WHERE recovery_state IN ('ready','retry_wait');

-- Verified identity/unit evidence and rule history are metadata, not a second
-- stock ledger. Imports and approvals use dedicated human-authorized actions.
CREATE TABLE IF NOT EXISTS shopee004_stock_identity_evidence (
  reference uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('seller_catalog','seller_description','pos_unit','owner_unit','reviewed_stock_rule')),
  details jsonb NOT NULL CHECK (jsonb_typeof(details)='object'),
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shopee004_stock_identity_rule_versions (
  rule_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  operation_id uuid NOT NULL UNIQUE,
  listing_id text NOT NULL,
  variation_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('active','revoked')),
  rule jsonb NOT NULL CHECK (jsonb_typeof(rule)='object'),
  actor text NOT NULL,
  exception_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id,version),
  UNIQUE(listing_id,variation_id,version)
);
CREATE INDEX IF NOT EXISTS shopee004_stock_identity_latest
  ON shopee004_stock_identity_rule_versions(listing_id,variation_id,version DESC);
CREATE TABLE IF NOT EXISTS shopee004_stock_identity_operations (
  operation_id uuid PRIMARY KEY,
  request jsonb NOT NULL CHECK (jsonb_typeof(request)='object'),
  outcome jsonb NOT NULL CHECK (jsonb_typeof(outcome)='object'),
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shopee004_stock_identity_recovery_jobs (
  operation_id uuid PRIMARY KEY,
  identities jsonb NOT NULL CHECK (jsonb_typeof(identities)='array'),
  product_codes jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(product_codes)='array'),
  cursor text NOT NULL DEFAULT '',
  scanned integer NOT NULL DEFAULT 0 CHECK (scanned >= 0),
  completed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shopee004_stock_identity_recovery_pending
  ON shopee004_stock_identity_recovery_jobs(created_at) WHERE NOT completed;

COMMENT ON TABLE shopee004_stock_identity_rule_versions IS 'Append-only exact identity/unit approvals. Never grants cancellation, dispatch, return or baseline approval.';
COMMENT ON TABLE shopee004_stock_identity_evidence IS 'Server-verified catalog/POS unit evidence; caller-supplied reference strings alone are not proof.';
COMMENT ON COLUMN shopee004_stock_dirty.recovery_revision IS 'Revision whose failure budget applies. Source or reviewed-rule revision changes may safely wake the existing queue.';
COMMIT;
