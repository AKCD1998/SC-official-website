# Changelog

## 2026-11-12 — Reconcile complete SCCRM receipt history automatically

- Commit a private completeness job with each receipt and enroll eligible older
  claims under an initial native-read barrier. Keep history available first.
- Lease independent headless branch/HQ verification, fill only guarded missing
  fields/exact suffix rows, and retain original/final snapshot and mirror evidence.
- Recheck successful receipts, fence expired/stale leases and native revisions,
  expose conflict/retry states, and preserve claim/item/member/point identities.
- Add a disabled-by-default pilot control, narrowly authenticated endpoints,
  PostgreSQL integration tests and two actual-receipt end-to-end copy tests.
- Reuse the terminal's completeness status in the central member sync log, so
  successful native delivery cannot hide a pending audit or a later conflict.

## 2026-11-11 — Adopt finalized Ada receipt times without duplicating history

- Accept versioned native time proof only after the existing receipt, member,
  final paid state, total and source item rows pass the native receiver guards.
- Adopt only the selling branch's final timestamp on its existing SCCRM claim
  and explicitly linked mirror. Preserve immutable submitted payload/time and
  both timestamps in the audit and staff/member sync log. No points are awarded.
- Automatically recheck legacy time holds once for upgraded workers; unfinished
  bills retry and true amount/item/owner conflicts remain held for review.
- Verify real PostgreSQL transactions, expired leases, lost acknowledgements,
  immutable identity, unchanged items/points and rolling worker compatibility.

## 2026-11-11 — SCCRM-first history and durable Ada delivery

- Commit receipt history and an immutable private outbox atomically before
  waiting for Ada membership/points. Preserve receipt ownership and replay guards.
- Add branch-scoped staff logs/retry and central admin member sync histories.
- Run a separate bounded receipt-delivery capability for the headless HQ worker;
  lease recovery, native proof identity and per-target failures remain durable.
- Keep Ada as point authority. The receiver only links existing paid bills and
  never creates sales, changes amounts or awards points.

## Unreleased — Cashier confirms existing members and shared contact phones

- Show all exact-phone candidates only to an authenticated staff device. A signed,
  short-lived review binds the draft, device and candidates before the cashier
  chooses the existing person or explicitly creates a different person.
- Store shared contact phones separately from unique account phones. Preserve
  existing customer profiles and bill ownership; keep confirmation requests
  idempotent after concurrent retries or a lost response.
- Add private confirmation audit and a contact-phone column through the scoped
  migration. Keep the existing account-phone uniqueness rule. Gate the new API
  until its schema and HQ/branch native protocol are provisioned and verified.
- Verify real PostgreSQL signup, selection, contact search/edit, stale reviews,
  duplicate requests, history ownership and rollback without production writes.

## 2026-11-10 — Thai mobile numbers for new member registrations

- Validate new POS, counter and QR registrations as Thai mobile numbers with
  10 digits beginning 06, 08 or 09 before creating member data. Normalize Thai
  digits, spacing and Thai country prefixes into the local 0-prefixed form.
- Validate the QR input before submission and return a specific correction
  message to older desktop clients. Existing contact editing retains its API.

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
