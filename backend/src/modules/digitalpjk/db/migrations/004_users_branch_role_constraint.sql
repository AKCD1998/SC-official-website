ALTER TABLE users
ALTER COLUMN branch_id DROP NOT NULL;

ALTER TABLE users
DROP CONSTRAINT IF EXISTS chk_users_branch_required_for_user;

ALTER TABLE users
ADD CONSTRAINT chk_users_branch_required_for_user
CHECK (
  role = 'admin' OR branch_id IS NOT NULL
);
