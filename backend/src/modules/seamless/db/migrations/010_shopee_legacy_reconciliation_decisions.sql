BEGIN;

-- Manual review is deliberately separated from applying a shop reassignment. A reviewed
-- decision must not mutate quarantined rows until a later, separately approved merge step has
-- checked collisions against already re-synced shop-scoped orders and events.
CREATE TABLE IF NOT EXISTS shopee_legacy_reconciliation_decisions (
  order_number text PRIMARY KEY CHECK (order_number ~ '^[A-Z0-9]{8,40}$'),
  selected_shop_code text NOT NULL CHECK (selected_shop_code IN (
    'sc-drug-store',
    'dr-morepen'
  )),
  suggested_shop_code text CHECK (suggested_shop_code IN (
    'sc-drug-store',
    'dr-morepen'
  )),
  evidence_status text NOT NULL CHECK (evidence_status IN (
    'recipient_match',
    'recipient_conflict',
    'recipient_unknown',
    'message_not_found',
    'metadata_unavailable'
  )),
  decision_status text NOT NULL DEFAULT 'reviewed' CHECK (decision_status IN (
    'reviewed',
    'applied'
  )),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (decision_status = 'reviewed' AND applied_at IS NULL)
    OR (decision_status = 'applied' AND applied_at IS NOT NULL)
  )
);

DROP TRIGGER IF EXISTS trg_shopee_legacy_reconciliation_decisions_updated_at
  ON shopee_legacy_reconciliation_decisions;
CREATE TRIGGER trg_shopee_legacy_reconciliation_decisions_updated_at
BEFORE UPDATE ON shopee_legacy_reconciliation_decisions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_shopee_legacy_reconciliation_decisions_status
  ON shopee_legacy_reconciliation_decisions (decision_status, reviewed_at DESC);

COMMENT ON TABLE shopee_legacy_reconciliation_decisions IS
  'Admin-reviewed shop choices for quarantined Shopee orders. Review does not mutate or merge legacy rows.';
COMMENT ON COLUMN shopee_legacy_reconciliation_decisions.evidence_status IS
  'Bounded routing result derived from live Gmail From/To metadata; no raw headers, Gmail IDs, subject, body, or buyer identifier is stored.';

COMMIT;
