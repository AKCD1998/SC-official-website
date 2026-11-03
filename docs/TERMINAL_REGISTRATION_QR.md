# Registration source per POS

One form is served by eight public links: `/join/r/001-001`, `001-002`,
`003-001`, `003-002`, `004-001`, `004-002`, `005-001`, `005-002`.
Each link has a printable sign at the same path plus `/qr`.

The server allowlist resolves branch and POS on both page load and submission.
Customers fill name, surname, phone and consent; the branch selector is replaced
by the source branch label. Posted branch/POS fields cannot override the referral.
Invalid referrals fail before a database connection. Query alias `?ref=003-002`
redirects to its canonical path. Old `/join` links and manual branch selection
remain compatible; the old `?branch=` value is only a preselection on that form.

`crm_reporting.member_registrations` stores the resolved `branch_code`, `pos_code`
and `referral_code` in the same transaction as the new identity and consent.
The existing member primary key prevents retry counts. Existing phone numbers
retain their original account, event and source; signing up again is not a new
recruitment event. StockDay's existing aggregate reads branch_code unchanged.

Apply only `backend/supabase/migrations/20261103084446_crm_terminal_referrals.sql`
before deploying this writer. It adds two nullable metadata columns and a check;
it neither backfills nor modifies profiles, historical events, Ada or points.
The private schema privileges and RLS stay unchanged. Reapplying is safe. The
existing reporting provisioner includes this additive migration for new installs.

Desktop 1.3.17 selects its bundled QR using the verified approved Tailscale node,
not SQL address or copied settings. Unknown nodes/HQ cannot silently show a
branch QR. Public links identify where the QR originated; they are shareable
and do not authenticate a device or prove the customer's physical location.

Rollback: recommend the prior signed desktop release and restore the prior
backend. Keep the nullable columns and existing events; no destructive rollback
or customer cleanup is required. Never deploy the new writer before its columns.

Verification: all eight links/assets and invalid references; local PostgreSQL
signup with forged branch/POS, concurrent/lost-response retries, preservation of
existing profile/source, origin constraints and full transaction rollback. Decode
each generated QR offline and verify the native node-to-link mapping separately.
