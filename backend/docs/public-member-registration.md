# Customer QR registration

`GET /join` is a public Thai mobile form for first name, surname and Thai phone.
It requires general membership consent but no email, DOB, password, staff PIN,
OTP or app installation. `GET /join/qr` is a printable counter sign; its SVG
encodes `https://sc-official-website.onrender.com/join`. Print/distribute it only
after that path has been deployed and verified. The existing staff forms remain
unchanged.

`POST /join/submit` accepts JSON `{ firstName, lastName, phone, consent: true }`.
The server validates and normalizes all input, then inserts `users`,
`member_profiles` (bronze) and `crm_member_consents` (version `qr-v1.0`) in one
transaction. Names are combined into the existing `users.full_name` contract.
It grants no authentication session and leaves `is_verified=false`; a form
submission does not establish phone ownership. Health and marketing consent stay
false. This records a member, not a mobile login account or an award of points.

Canonical phone conflicts are handled by the existing unique index and never
overwrite an existing user or append a consent on their behalf. New/duplicate
submissions both return the same minimal 200 acknowledgement, with no member ID,
name, phone, balance or auth token. Nothing is stored in browser storage or URLs.
The UI reports success only after the database commit is acknowledged and keeps
entered fields on network/server failure. A timed-out request can be retried
without creating a second member.

## Database / operational assumptions

This uses the exact nullable identity/profile/consent schema from the reviewed
`202610200001_crm_counter_bootstrap.sql`, including a UNIQUE phone index. There
are no new migrations or automatic provisioning, and no writes to AdaPos/AdaAcc.
Before deployment, verify those three tables and the unique index in the actual
configured CRM database using read-only checks. Do not run old Knex migrations
to satisfy missing tables. Saving a member here does not fix missing loyalty
ledgers, POS search, customer authentication or promotions in an incomplete
trial database. Test those separately before promising a complete store flow.

Only this public sub-app trusts one reverse proxy (the Render edge); the shared
app's trust-proxy/auth/CORS behavior is unchanged. The rate limiter uses the
rightmost forwarded client hop, caps submissions at 30 per IP per 15 minutes,
and bounds its process-local map to 5000 clients. Multiple instances have separate
quotas and restart clears them. Revalidate proxy topology if hosting changes.
This is baseline abuse protection, not phone verification or a CAPTCHA.

The form is served from the API host so submissions are same-origin. External
origins are rejected; JSON requests are capped at 4 KiB. Restrictive CSP,
no-store and no-referrer headers apply only to `/join`. Database errors are
generic to the client and logs contain error codes, not names, phones or SQL.

## Validation

Run `npm test -- --runTestsByPath tests/public-member-registration.test.cjs`
from `backend/`. For real PostgreSQL transaction/concurrency validation, supply
`CRM_PUBLIC_POSTGRES_SMOKE=1` and `SCCRM_PUBLIC_TEST_DATABASE_URL` for a **fresh,
disposable local** database named `crm_public_registration_test_*`, then run
`tests/public-member-registration-postgres.integration.test.cjs`. The test
refuses remote hosts, other database names and existing CRM tables. It applies
the existing bootstrap only in that disposable database and retains fixtures
until the disposable instance is removed.

With that local fixture database still running, execute
`node scripts/preview-member-registration.cjs` and open
`http://127.0.0.1:4318/join`. The preview never loads `.env`, binds only to loopback
and visibly labels test data. It does not publish a site or touch production.

The user authorized production deployment on 2026-10-21, using the existing
Supabase database and Render backend. A verified-TLS, read-only preflight
confirmed all three tables, the unique phone index and cascading fixture-cleanup
foreign keys. No migration or database configuration change is needed.
The canonical backend checkout contains unrelated work, so the implementation
is isolated on `codex/crm-self-registration`. Live verification uses only a newly
created synthetic member and removes that exact fixture after checking the
database commit and duplicate protection; it never changes an existing customer.

### Verification recorded on 2026-10-21

- Backend Jest: 100 suites and 1,115 tests passed, 16 tests skipped. This includes
  four new public-registration PostgreSQL tests and seven existing counter
  PostgreSQL tests against separate disposable PostgreSQL 18 databases.
- The new route/validation suite's 26 tests passed again after adding an explicit
  POST action to prevent a no-JavaScript fallback putting personal data in a URL.
- Existing SCCRMMVP validation: 54 tests passed and TypeScript `--noEmit` exited
  successfully. Windows npm child-shell command resolution failed in this host,
  so these checks used the installed Jest/TypeScript Node entry points directly;
  this is not a claim that the literal npm/npx launcher commands passed.
- The pre-existing workflow text test initially failed on Windows CRLF. The
  local checkout of that unchanged YAML was normalized to its committed LF;
  no workflow change is part of this patch. The complete backend rerun passed.
- Browser: synthetic submission rejected an invalid phone, preserved the form,
  then saved successfully with a valid phone. A separate SQL join confirmed one
  unverified identity, one profile and one consent in the preview database.
  Form and printable QR were visually inspected. Screenshots and detailed Jest
  reports are retained in ignored `tmp/`; preview data never reaches production.
