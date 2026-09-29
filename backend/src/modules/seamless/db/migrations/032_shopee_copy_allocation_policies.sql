BEGIN;
CREATE TABLE IF NOT EXISTS shopee_copy_allocation_policies (
  shop_code text NOT NULL CHECK (shop_code IN ('sc-drug-store', 'dr-morepen')),
  policy_key text NOT NULL CHECK (policy_key ~ '^[a-z][a-z0-9_-]{0,99}$'),
  policy jsonb NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
  approval jsonb NOT NULL CHECK ((jsonb_typeof(approval) = 'object'
    AND approval->>'kind' = 'user_confirmed_allocation'
    AND length(trim(approval->>'caseId')) > 0
    AND approval->>'responseSha256' ~ '^[a-f0-9]{64}$') IS TRUE),
  approved_by text NOT NULL CHECK (length(trim(approved_by)) > 0),
  approved_at timestamptz NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (shop_code, policy_key)
);
COMMENT ON TABLE shopee_copy_allocation_policies IS
  'Private owner-approved accounting allocation methods, separate from immutable Shopee financial facts and source price evidence.';
COMMIT;
