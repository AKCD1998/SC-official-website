# Customer purchase history web portal

`/my-purchases/` is a normal mobile-friendly web page. A customer enters an email,
receives a six-digit one-use code, then sees only purchases saved to their original
member profile. Bill details include product name, SKU, unit, quantity, unit price,
line total, branch, sale date/time and recorded returns. Legacy missing units remain
explicitly unspecified. Internal staff identifiers and points are not exposed.

Customers registered using only name and phone must first have staff verify their
identity and add their email to that same member through the existing staff/POS edit
flow. The public portal never attaches an arbitrary member ID, phone or name to an
email. An email must match exactly one active existing member after verification.
It does not create replacement member accounts or alter existing bills/points.

## Authentication and delivery

OTP codes expire after ten minutes, have five attempts, and are consumed in a
PostgreSQL transaction. Resending invalidates earlier codes. Undelivered codes cannot
log in. A verified email with no unique active member receives staff-linking guidance;
no membership lookup occurs before email ownership is proved.

Rate limits persist across application instances: one request per email per minute,
three per email per fifteen minutes, ten per IP per fifteen minutes, and eighty
requests globally per rolling day. The global limit also bounds free-mail quota
exposure. Codes and IP/email fingerprints are purpose-specific HMACs, not plaintext.

Sessions last at most thirty days and use random opaque HttpOnly, Secure,
SameSite=Strict cookies scoped to `/my-purchases`. The database stores only token
hashes. Session use rechecks active membership and the verified email fingerprint;
changing the member's email invalidates an old session. Logout revokes it. Purchase
data and tokens are never persisted in browser storage. Responses are no-store,
the page has a restrictive CSP, and submissions require the configured same origin.

The gateway supports Brevo, SendGrid and Resend over HTTPS. It does not modify the
existing site's or Seamless module's email configuration. Namespaced portal settings
can override existing `EMAIL_PROVIDER`, `BREVO_API_KEY`, `SENDGRID_API_KEY`, `MAIL_USER`
and `OTP_SECRET`; the latter derives a purpose-specific key. Delivery failure never
returns a fake success or a usable code.

## Release prerequisites

The feature is disabled unless `SC_OFFICIAL_MEMBER_PORTAL_ENABLED=true` and mail and
session configuration are present. Prefer the existing configured mail provider;
having a key alone does not prove current sending quota or successful delivery.
The SendGrid key inspected locally on 24 October 2026 authenticated read-only, but
reported a free account with zero assigned/remaining credits. The old Gmail SMTP
credential failed authentication. No test email was sent. A 13 August 2026 commit
added Brevo to the existing Seamless mailer; production provider configuration still
needs confirmation. Existing members inspected read-only had no email addresses.

Run only the scoped `backend/scripts/provision-member-portal.cjs`, which verifies
the existing CRM base, uses verified TLS and a short lock timeout, creates the two
new RLS-protected credential tables, revokes browser-role access, and records its
own migration. Its default is a complete dry run ending in rollback. `--apply`
commits this migration only; do not run all historical Knex migrations. The exact
SQL was dry-run successfully against the existing Supabase with verified TLS.

Deploy the checked source with the feature disabled, confirm the existing provider,
then enable the namespaced flag when the credential tables and mail delivery are
ready. Disabling that flag is the application rollback; existing POS operation and
purchase storage are unaffected. Do not erase the tables to roll back.

## Verification

Route tests cover cookie attributes, owner-scoped pagination, anonymous/staff-token
refusal, CSRF, privacy projection, failed mail and logout. PostgreSQL integration
tests exercise one-use/concurrent OTP verification, attempts, superseded and expired
codes, rate limits, identity matching, revocation and RLS in a disposable local/CI
schema. They refuse a production/non-loopback test URL. No real customer or AdaPos
data is written by these tests. The local UI preview uses explicit synthetic data
and a fake mailer outside the production application.
