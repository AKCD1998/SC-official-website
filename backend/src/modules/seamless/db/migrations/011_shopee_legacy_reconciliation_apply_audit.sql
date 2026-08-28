BEGIN;

ALTER TABLE shopee_legacy_reconciliation_decisions
  ADD COLUMN IF NOT EXISTS decision_source text NOT NULL DEFAULT 'manual';

ALTER TABLE shopee_legacy_reconciliation_decisions
  DROP CONSTRAINT IF EXISTS shopee_legacy_reconciliation_decisions_evidence_status_check;
ALTER TABLE shopee_legacy_reconciliation_decisions
  ADD CONSTRAINT shopee_legacy_reconciliation_decisions_evidence_status_check
    CHECK (evidence_status IN (
      'mailbox_match',
      'recipient_match',
      'recipient_conflict',
      'recipient_unknown',
      'message_not_found',
      'metadata_unavailable'
    ));

ALTER TABLE shopee_legacy_reconciliation_decisions
  DROP CONSTRAINT IF EXISTS shopee_legacy_reconciliation_decisions_decision_source_check;
ALTER TABLE shopee_legacy_reconciliation_decisions
  ADD CONSTRAINT shopee_legacy_reconciliation_decisions_decision_source_check
    CHECK (decision_source IN ('automatic', 'manual'));

CREATE TABLE IF NOT EXISTS shopee_legacy_reconciliation_apply_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_digest text NOT NULL CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'rolled_back')),
  order_count integer NOT NULL CHECK (order_count > 0),
  event_count integer NOT NULL CHECK (event_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  rolled_back_at timestamptz,
  CHECK (
    (status = 'applied' AND rolled_back_at IS NULL)
    OR (status = 'rolled_back' AND rolled_back_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS shopee_legacy_reconciliation_apply_items (
  batch_id uuid NOT NULL REFERENCES shopee_legacy_reconciliation_apply_batches(id),
  order_number text NOT NULL CHECK (order_number ~ '^[A-Z0-9]{8,40}$'),
  target_shop_code text NOT NULL CHECK (target_shop_code IN (
    'sc-drug-store',
    'dr-morepen'
  )),
  target_order_existed boolean NOT NULL,
  legacy_order_snapshot jsonb NOT NULL,
  target_order_snapshot jsonb,
  moved_event_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  PRIMARY KEY (batch_id, order_number)
);

CREATE INDEX IF NOT EXISTS idx_shopee_legacy_apply_batches_created_at
  ON shopee_legacy_reconciliation_apply_batches (created_at DESC);

COMMENT ON TABLE shopee_legacy_reconciliation_apply_batches IS
  'Audit batches for controlled, digest-gated moves from legacy-unattributed into a real Shopee shop.';
COMMENT ON TABLE shopee_legacy_reconciliation_apply_items IS
  'Privacy-safe order snapshots and moved event UUIDs used to audit or roll back a controlled legacy attribution apply.';
COMMENT ON COLUMN shopee_legacy_reconciliation_apply_items.legacy_order_snapshot IS
  'Bounded Shopee business fields only. Never store raw Gmail content, headers, buyer identifiers, or credentials.';

COMMIT;
