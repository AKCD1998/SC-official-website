# StockDay member directory and receipt units

New internal GET endpoints `/internal/crm/member-directory` and
`/internal/crm/member-directory/:id/purchase-history` reuse the existing
`SCCRM_INTERNAL_API_TOKEN`. They are consumed only by the authenticated shared
backend; browser clients never receive this credential. The directory joins
`users` with `member_profiles`, including both QR and staff registrations, and
returns only ID, member code, name, phone, active state and registration time.
It never selects medical records, identity documents or authentication fields.

Search is parameterized with literal wildcard escaping. Count/page use one
database statement. History reuses the same reader as the existing POS route,
including member-scoped claims, microsecond-preserving pagination and refunds.
Existing POS routes/authentication/request field meanings are preserved.

Optional `unitCode` and `unitName` are stored in receipt snapshots and mirrored
to the already-existing CRM sale-line unit columns. Old clients/rows remain
valid and missing units remain null. There is no schema migration and no
backfill from a current product catalog. Units from AdaPos are the per-receipt
`FTPunCode` / `FTSdtUnitName`, verified read-only on branch 005.

Verification: directory/internal-auth/history tests plus existing POS regression
tests; CI-equivalent local backend suite 1102 passed, 31 skipped (startup harness
excluded as in CI). Actual Supabase read-only transaction verified directory
SQL and the shared member-history query against the existing schema. This does
not claim a physical sale was confirmed at a POS terminal.
