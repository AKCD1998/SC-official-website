-- Applied through Supabase migration add_ada_customer_name_lookup_index.
-- Supports the existing immutable name equality in existing_member_candidate.
-- No customer values, matching rules, function privileges, or policies change.
-- Small live table (~1,900 rows); fail promptly rather than wait behind a writer.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';
CREATE INDEX IF NOT EXISTS history_customer_active_name_lookup
ON ada_history.customers(source_id,ada_history.member_name_key(name))
WHERE active='1';
COMMIT;

-- Rollback, if required: DROP INDEX ada_history.history_customer_active_name_lookup;
