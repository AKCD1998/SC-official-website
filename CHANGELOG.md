# Changelog

## 2026-10-21 — Customer QR registration

- Add `/join`, a mobile form for customers to submit first name, surname and
  Thai phone with membership consent, plus a printable `/join/qr` sign.
- Store identity, member profile and consent atomically in the existing CRM
  schema without issuing a login session. Duplicate numbers preserve existing
  records and receive the same privacy-preserving acknowledgement.
- Scope request-size/origin checks, throttling and browser security headers to
  the new route. Add PostgreSQL concurrency/rollback tests and a local-only
  preview; existing employee and customer login routes are unchanged.
