# SCCRM signup reporting

New-member events are recorded in `crm_reporting.member_registrations` inside
each signup transaction. The primary key is the original member UUID. Do not
insert events from Ada imports, code assignments, profile updates, adoption or
fanout sync. Do not backfill from `member_profiles.created_at`: a newly created
profile can represent an existing Ada customer.

Staff/POS/counter signups use the branch on the authenticated device, captured
at signup time. QR signups use the validated customer-selected branch, with
`/join?branch=004` supported for preselection. Missing or non-campaign device
branches remain NULL. Existing QR clients can still submit without a branch.

`GET /internal/crm/member-registrations?month=2026-11` requires the existing
internal token and returns only Thai daily counts, an as-of timestamp and the
tracking start. The StockDay shared API applies role/branch scoping and the
recurring 500/500/250/250 monthly targets. This endpoint never exposes member
identities, contact details, device identifiers or health records.

## Release order

1. Run `node scripts/provision-member-registration-reporting.cjs` against the
   intended CRM database. Default mode rolls back. Review the result, then run
   with `--apply` to create the private reporting tables. No bulk migration
   runner is involved. RLS is enabled and browser-role access is revoked.
2. Deploy the website signup writers. Their event insert needs the new tables;
   deploy them only after step 1.
3. Once the writers are verified live, run the provisioner with
   `--apply --activate` to fix the actual tracking start. Activation is
   idempotent. Events predating activation are excluded from the report.
4. Deploy PaaSRTSM's authenticated bridge and then StockDay's focus-products UI.

No existing registration can be assigned to a branch from an AR code, a later
purchase branch, a destination sync database or a device's current location.
The first partial month must retain its tracking-start disclosure.

## Verification

`member-registration-reporting-postgres.integration.test.cjs` requires an
explicit local `SCCRM_REGISTRATION_TEST_DATABASE_URL` whose database starts with
`crm_registration_test_` and contains no CRM schema. The test provisions only
that disposable copy and exercises the real signup routes and aggregate SQL.
CI creates a separate database for it. Tests cover retries, transaction rollback,
branch spoofing, missing branches, legacy exclusion, Thai day/month boundaries,
internal authentication and reporting privacy.

Keep reporting tables when rolling back code. Hide the report before reverting
writers, because a period running the old writers is a real coverage gap.
