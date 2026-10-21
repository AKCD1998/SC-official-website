# Public member-registration integration notes

Purchase-history verification: see `backend/docs/purchase-history.md`. The legacy
claim amount means eligible spend, not a paid total. Older records cannot establish
an original header total or item order; the API labels the available fallback.
Synthetic WinForms/API/PostgreSQL checks do not establish positive startup or
receipt-watcher behavior on a physical approved company POS. Keep that acceptance
limit explicit. Points resets are a future separate request and must preserve
member-linked receipt history; no reset is authorized or performed here.

The public `/join` feature uses the existing identity, member-profile and consent
schema defined by `backend/migrations/202610200001_crm_counter_bootstrap.sql`.
It does not apply migrations or infer additions from frontend fields.

Production preflight on 2026-10-21 confirmed the existing Supabase database has
all three required tables, the unique phone index and cascading member/consent
foreign keys. The connection used a verified provider CA and a read-only
transaction; no migration or customer write was performed during preflight.

Integration considerations:

- Keep the existing configured CRM database and unique non-null phone index.
  Do not provision another database or run historical migrations for this form.
- `dob`, email and password are nullable. Public submissions must remain
  unverified and must not issue customer/staff authentication tokens.
- The public sub-app is behind one trusted Render proxy. Other deployment
  topologies need a review of its scoped `trust proxy` setting and IP throttling.
- Registering an identity does not establish that the separately deployed POS,
  point ledger, promotions or mobile-login schema is present or working. The
  current counter bootstrap explicitly provisions only counter registration.

See `backend/docs/public-member-registration.md` for behavior and local test
instructions. No production/customer data is used by preview or tests.
