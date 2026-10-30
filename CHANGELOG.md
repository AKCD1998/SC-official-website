# Changelog

## 2026-10-30 — Search approved member links by every retained phone

- Search phones retained on all explicitly linked Ada codes, including formatted
  numbers, without copying them into login credentials or merging from a search.
- Keep the existing primary `phone` field and add `phoneNumbers` only for contacts
  with multiple numbers. Existing POS clients keep their response contract.
- Preserve the nonblank canonical-phone fallback in explicit mirror provisioning.

## 2026-10-29 — Preserve member lookup through Ada code aliases

- Resolve exact old SCCRM/Ada aliases to the same member UUID in both staff
  search APIs while displaying the member's current canonical code.
- Reject conflicting alias/current-code ownership, preserve active-member
  filtering, and retain existing authentication, imports and token formats.
- Keep alias reads disabled until the private schema and scoped SELECT grants
  are provisioned; no migration, profile update or native Ada write is included.

## 2026-10-29 — Include medicine purchases in member points

- Include medicine line totals under the operator-approved earning policy while
  keeping the 25-baht base rate and existing promotions.
- Recalculate exact legacy POS subtotals on the server, record the policy in
  new snapshots, and preserve historical awards and duplicate-bill protection.
- Verify medicine-only, mixed and zero-value bills with real PostgreSQL routes
  and WinForms component checks; no Ada writes or historical backfill.

## 2026-10-21 — Member purchase history

- Allow existing staff sessions to read member history; retain legacy POS keys
  and fail closed on invalid/revoked bearer sessions.
- Preserve original receipt totals, discounts, ordered items and POS metadata
  independently of eligible spend and points. Store confirmed zero-point bills.
- Add keyset history pagination, additive RLS-preserving provisioning and real
  PostgreSQL/WinForms integration checks with removable synthetic fixtures.

## 2026-10-21 — Customer QR registration

- Add `/join`, a mobile form for customers to submit first name, surname and
  Thai phone with membership consent, plus a printable `/join/qr` sign.
- Store identity, member profile and consent atomically in the existing CRM
  schema without issuing a login session. Duplicate numbers preserve existing
  records and receive the same privacy-preserving acknowledgement.
- Scope request-size/origin checks, throttling and browser security headers to
  the new route. Add PostgreSQL concurrency/rollback tests and a local-only
  preview; existing employee and customer login routes are unchanged.
