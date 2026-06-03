-- loyalty_cashier_claims.sql
-- Cashier-initiated loyalty claim tables for SCCRMonPOS desktop flow.
-- Points source-of-truth remains point_ledger (FK to users.id).
-- These tables add receipt detail and duplicate-claim prevention.

CREATE TABLE IF NOT EXISTS loyalty_claims (
  id                 TEXT PRIMARY KEY,
  receipt_no         TEXT NOT NULL,
  branch_code        TEXT NOT NULL,
  cashier_staff_code TEXT,
  sold_at            TIMESTAMPTZ,
  total_amount       NUMERIC(14, 2) NOT NULL,
  preview_points     INTEGER,
  awarded_points     INTEGER NOT NULL DEFAULT 0,
  user_id            UUID NOT NULL REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT loyalty_claims_branch_receipt_unique UNIQUE (branch_code, receipt_no)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_claims_user_id ON loyalty_claims (user_id);

CREATE TABLE IF NOT EXISTS loyalty_claim_items (
  id           TEXT PRIMARY KEY,
  claim_id     TEXT NOT NULL REFERENCES loyalty_claims(id) ON DELETE CASCADE,
  product_code TEXT,
  product_name TEXT,
  qty          NUMERIC(14, 4) NOT NULL DEFAULT 0,
  unit_price   NUMERIC(14, 2) NOT NULL DEFAULT 0,
  line_total   NUMERIC(14, 2) NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
