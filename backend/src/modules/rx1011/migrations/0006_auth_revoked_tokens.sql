BEGIN;

CREATE TABLE IF NOT EXISTS revoked_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jti uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  revoked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  reason text,
  CONSTRAINT ck_revoked_tokens_exp_after_revoked
    CHECK (expires_at >= revoked_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_revoked_tokens_jti
  ON revoked_tokens (jti);

CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires_at
  ON revoked_tokens (expires_at);

COMMENT ON TABLE revoked_tokens IS
  'Blacklist token table for forced logout and JWT revocation before natural expiry.';
COMMENT ON COLUMN revoked_tokens.jti IS
  'JWT token unique identifier (jti).';
COMMENT ON COLUMN revoked_tokens.user_id IS
  'User who owned the revoked token.';
COMMENT ON COLUMN revoked_tokens.expires_at IS
  'JWT expiration timestamp copied from token exp claim.';
COMMENT ON COLUMN revoked_tokens.reason IS
  'Reason for revocation (e.g. LOGOUT).';

-- Optional cleanup job (run periodically):
-- DELETE FROM revoked_tokens WHERE expires_at <= now();

COMMIT;
