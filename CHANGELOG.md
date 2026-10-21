# Changelog

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
