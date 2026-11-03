# Changelog

## 2026-11-03 — Record paid Ada sales containing item-removal Void lines

- Accept installed POS payloads containing an exact original/negative Void pair.
  Cancel both lines and retain later re-added goods, SKU, units, quantity and sale
  time; never discard negatives alone or treat returns as item removal.
- Preserve whitelisted original lines and cancellation pairs in the private
  receipt snapshot; customer history and sale mirrors contain actual purchases.
- Reject unmatched, partial/unproven or all-cancelled receipts with a clear
  reason. Keep Ada point authority, receipt ownership and duplicate locks intact.
  No Ada database changes or POS installation is required for this server fix.

## 2026-11-03 — Automatic registration source from terminal QR

- Serve one registration form through eight approved terminal referrals. Resolve
  branch/POS on the server without a customer branch selector or trusting posted
  branch values. Keep generic printed links compatible and reject unknown sources.
- Record referral/POS alongside the existing atomic signup event; concurrent
  retries and existing numbers preserve their original profile and recruitment.
- Add nullable private reporting metadata only, with an origin constraint and
  isolated PostgreSQL coverage. No Ada, point or historical signup changes.

## 2026-11-03 — Accept existing POS sessions for fleet commands

- Verify native device tokens with the same namespaced HMAC helper used by the
  existing staff login and member API. The first fleet route used a plain digest
  and rejected valid installed POS sessions with 401.
- Preserve existing tokens, revocation and administrator-key verification. Add
  integration checks using the real shared helper and reject plain-digest rows.
  No POS reinstall, device re-login or customer change is required by this fix.

## 2026-11-03 — Administrator-requested SCCRM device updates

- Add a private, paused-by-default operational queue for explicitly requested
  updates. Device sessions receive only their own immutable signed release;
  a separate hashed admin credential controls commands from SCProductDev.
- Retain queued offline work, deduplicate retries and require the exact installed
  executable hash before reporting success. No customer, Ada, point or purchase
  records participate in this queue.
- Add isolated PostgreSQL protocol/security checks and publisher signature checks.
- Return a definite offline boolean for terminals awaiting first enrollment so
  the native console can read the inventory before any terminal connects.

## 2026-11-03 — Keep member search and registration readable by older POS clients

- Omit the optional `currentPoints` number when Ada marks a balance unavailable.
  Preserve the member identity, source/status and `pointsAvailable=false`; do not
  substitute zero or change stored scores. POS versions through 1.3.11 use a
  non-nullable Int32 and rejected the entire member response on JSON null.
- Cover search, profile/edit and successful registration responses. Available
  native balances, normal preview responses, registration transactions and
  duplicate-phone rejection keep their existing behavior.

## 2026-11-02 — Use Ada as the points authority

- Add the opt-in `SC_OFFICIAL_ADA_POINTS_MODE=ada-primary` cutover. Staff and
  customer balances read the verified private Ada projection; unavailable/stale
  balances are explicit and never fall back to the archived SCCRM ledger.
- Save receipt history without awarding points again. Display Ada's original
  receipt award, preserve the old SCCRM award separately, and require earning,
  redemption and refund point changes to originate in Ada.
- Share bill ownership and locking across staff, mobile and import paths so a
  previously recorded bill shows its saved member and cannot be reassigned.
- Replace the local promotion preview with Ada workflow guidance in this mode.
  Existing auth, membership, purchase records and archived ledger are preserved.
- Validation: 190 backend tests; deployment and live cutover are recorded in the
  separate operations evidence rather than inferred from the test results.

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
