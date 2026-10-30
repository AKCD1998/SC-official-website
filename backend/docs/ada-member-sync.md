# HQ000 Ada member and purchase-history bridge

`SC_OFFICIAL_ADA_SYNC_ENABLED=true` exposes the separately provisioned
`ada_history` schema through the existing authenticated member directory,
POS member search/profile/history, and private member purchase portal. The
default is disabled. It does not run a migration or start a background worker.

The Session 0 Windows service `SCCRMHQMemberSync` on HQ000 (`SERVER`) owns the
continuous bridge. It runs independently of any browser, AdaSmart window, or
Shopee task. Source reads page 100 records with one SQL query worker and a
one-second lock wait; full refresh runs every five minutes. New SCCRM members
are checked every 30 seconds. The service uses its own restricted SQL login
and Supabase role, verified TLS, and machine-encrypted credentials.

## Identity and data behavior

- Approved links retain every original Ada phone. Staff/POS and the private
  member directory search all linked phones without changing login credentials.
  The existing `phone` response remains the primary phone; `phoneNumbers` is an
  additive list when multiple contacts exist. A phone search never creates a
  link or merges identities. Same-phone contacts with separate UUIDs remain
  separate choices. No new schema, configuration or POS update is required.
- Native source identity is `hq000/AdaAcc` plus the exact Ada customer code.
  Duplicate phones and blank phones remain separate; names/phones never
  automatically establish a customer login or combine histories.
- Existing SCCRM members retain their UUIDs and accounts. Only explicitly
  approved links or acknowledgements of a new native member bind identities.
- Legacy Ada contacts are virtual directory entries. A staff member's explicit
  edit or bill selection materializes an unverified contact inside the existing
  transaction, without copying the Ada email/phone into login credentials.
- Imported history retains every finalized, non-general member sale/return,
  its SKU, unit, quantity and native Bangkok date/time. General/no-member bills
  do not become personal history. Returns carry `documentType: return` and a
  negative header total. Existing SCCRM bill ownership wins over imported
  duplicates for the same branch/document.
- Historical Ada points remain in the source mirror. Import does not award
  points again or overwrite the live SCCRM point ledger.
- Outbound v1 creates new Ada members only through an owned, idempotent
  procedure. It cannot directly update/delete native customers, sales or lines.
  A matching existing phone, code collision, or unsupported native text goes to
  review. Existing native customer data is never overwritten. Additional SCCRM
  fields stay in SCCRM; profile edits and two-way point adjustments are not
  enabled by this release.

## Release evidence and recovery

Before activation the full copy contained 1,438 customer codes, 4,075 sales,
21 returns and 12,491 lines. Full-copy restart/replay/identity tests passed,
including a second full replay with zero changed records. The production
transport and real backend readers were also exercised against that copy;
native create/retry/collision/encoding behavior ran only on a shadow table.

The schema SQL is an explicit, operator-reviewed provisioning artifact under
`backend/sql/ada-member-mirror.sql`; it is not part of historical migration
runners. Source provisioning and the worker live in SCCRMonPOS `sync-agent/live`.
There are no source customer deletes or updates in this release.

To suspend bridge writes/reads, stop **only** `SCCRMHQMemberSync` on SERVER.
To hide imported records from the API, set the feature flag to `false` and
redeploy the official backend. Neither action deletes imported or native data.
Status is at `D:\SCCRM-HQ-LiveSync-20261024\live\status\status.json`;
`live\runtime\pause.request` pauses cycles while leaving the service alive.
Do not restart SQL Server, change firewall rules, or stop Shopee to manage this
bridge. Database rollback is not needed to disable the integration.

## Admin website: resolve existing-phone matches

StockDay's **สมาชิก → จัดการรหัส Ada** lists active SCCRM members whose phone
matches native contacts and who have no approved link. It excludes historical
review records once the member is linked. The administrator chooses a native
code, checks the identity confirmation and submits explicitly. Candidate cards
show exact native code/name/phone, branch, sale/return counts and last sale.
There is no automatic first-match selection or automatic retry of a write.

The StockDay proxy checks its admin session and CSRF, supplies the authenticated
actor, and uses a distinct backend-only `SCCRM_ADA_LINK_ADMIN_TOKEN`. It must
match the official backend's `SC_OFFICIAL_ADA_LINK_ADMIN_TOKEN`; it must not be
the existing POS/internal credential. The frontend receives neither credential.
Both services must be deployed/configured before shipping the frontend control.

Internal routes under `/internal/crm/member-directory`:

- `GET /ada-links?page=1&limit=25`: unresolved matching members.
- `GET /:id/ada-links`: candidate codes with a signed 10-minute review snapshot.
- `POST /:id/ada-links`: `{adaCode,reviewToken,actor:{id,role:'admin'}}`, requiring
  both the existing internal credential and `x-ada-link-admin-token`.

Confirmation locks the canonical member and native candidate in Supabase,
rechecks the phone/snapshot and existing bill owner, then inserts only an
approved `ada_history.member_links` row with the admin identity and timestamp.
It cannot overwrite/reassign an existing link, native profile, bill or points.
An identical confirmation returns success without changing the original audit
reference. Concurrent choices of the same native code permit only one owner.

`node scripts/check-ada-member-linking-copy.cjs` accepts only a fresh local test
database named `sccrm_ada_link_test_*`. The copy test covers code selection,
owner isolation, stale/expired previews, conflicting bill ownership, retries,
concurrent confirmations and preservation of original profiles/history/points.
