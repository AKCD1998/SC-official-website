# Branch 004 Shopee stock reservation shadow

This change prepares the calculation and evidence contracts for the shared branch 004
stock pool. It does not register a route, worker, timer, migration or activation flag.
It does not change branch-stock quantities, POS, Hourly, Full Sync, Transfer Delta,
the Gmail importer, or the existing quotation/accounting workflow.

## What can run now

- `shopeeStockProductMatch.js` combines the existing exact catalog, reviewed
  quotation-copy packs, ERP base units and independently read POS unit metadata.
  `shopeeStockQuantityEvidence.js` normalizes physical quantities before comparing
  pack counts. Conflicting evidence stays unresolved; accounting consolidation
  is not a physical stock mapping. Neither module changes the existing matchers.
- `shopeeStockReservationShadow.js` projects one reservation per shop/order into
  common POS stock identities, entirely in memory. Its printable summary contains
  operational counts and fixed reason codes, with no order IDs, SKU lists or quantities.
- `shopeeStockShadowReader.js` reads a bounded **current email-order snapshot** in
  a PostgreSQL repeatable-read, read-only transaction and always rolls it back.
  It accepts an existing authorized pool; it does not discover credentials.
- `node backend/scripts/shopee-stock-shadow.cjs --stdin` accepts a private offline
  snapshot and prints only the aggregate. There is no enable/apply mode.

The reader deliberately labels coverage incomplete. It does not silently treat
Seller Centre-only or report-only orders as covered, and it does not reconstruct
historical item lists from today's order snapshot. The start date is interpreted
in Asia/Bangkok. It is a lower bound for the order selection, not a reservation expiry.
Input caps fail rather than silently truncating an audit.

## Quantity and stock identity boundary

1. Match the shop, name and variant using existing reviewed rules. Caller-supplied
   `productMatch` fields cannot establish a stock mapping. Supplied source listing
   IDs and barcodes must not contradict the mapping.
2. Require a positive integer sale quantity and an evidenced per-sale multiplier.
   The existing reviewed ordinary exact-SKU contract supplies one ERP base unit;
   it does not require every normal SKU to appear in the separate multipack
   exception table. Missing ERP unit evidence still blocks the line.
3. Normalize pack quantities into the live POS base unit. An independently reviewed
   same-SKU rule can establish an exact packaging factor; conflicting factors block.
   Variant quantities take precedence over title quantities. A title's tablet/piece
   contents are not automatically extra stock units. Physical content ratios require
   agreeing POS and ERP stock definitions and supported unit factors. Decimal packs,
   physical splits, ambiguous generic pieces, explicit unit-review holds and
   conflicting stock definitions remain unresolved. No conversion comes from price,
   barcode proximity or name similarity.
4. Require supported stock factors and active POS products. Shared aliases require
   the same one-to-one master relationship as the reviewed Hourly reader; unsupported
   conversions stay in review. The current shadow additionally requires a unit base
   factor of one. It does not broaden the Hourly shared-stock contract.
5. A bundle needs independent verified quantities and base units for every physical
   component. Multiple components sharing a stock identity are summed. If any line
   is unresolved, the **entire order** is marked for review; its mapped subset must
   not be consumed as an authoritative reservation.

## Lifecycle and avoiding duplicate deductions

| Evidence | Shadow behavior |
| --- | --- |
| Confirmed order or shipment-due email | One provisional reservation, if units are verified |
| Duplicate/forwarded event or repeated order snapshot | No additional reservation |
| Conflicting duplicate identity or changed order snapshot | Review required |
| Verified cancellation before dispatch | Release the reservation |
| Cancellation email without dispatch proof | Review; do not infer that nothing was dispatched |
| Shipping/delivered/completed status | Keep outstanding demand until a verified POS issue link exists |
| Verified dispatch under an explicit owner-confirmed not-recorded-in-POS workflow | Classify as shipped-unposted demand; keep its outstanding stock effect exactly once |
| Verified partial POS issue already represented in the chosen stock basis | Retire only those issued units |
| Queued or completed quotation dry run | Never proof of stock issue |
| Refund, return notification or sellable-return receipt | No direct stock addition; reconcile through POS |

An issue link is accepted only with branch, shop, exact order identity, stock identity,
unique effect identity, positive quantity, verified POS-issue evidence, and the **same
stock-basis identity** selected for that product. Timestamp proximity alone is not
proof of inclusion in a NOLOCK-derived stock basis. An issue after the stock basis,
a mismatching basis, an unrelated product, over-issue, or contradictory duplicate
effect remains in review.

Gross lifetime issued units retire demand. A return does not subtract those issued
units and reopen the original reservation. Returned goods enter sellable on-hand
only through a verified physical receipt and POS stock effect, never by adding an
email refund quantity to stock again. Linking a Shopee order to a credit quotation
must preserve the same demand identity, rather than creating a second reservation.

There is currently **no production POS-issue adapter or persistent reservation ledger**
in this PR. Typed proof strings in private inputs are an adapter contract, not a
publicly accepted authorization. A future adapter must establish them from verified
documents and the actual stock basis; callers cannot infer them from a dry-run job.
The live reader supplies no such links and cannot certify double-count prevention
against actual POS issues yet.

The owner explicitly confirmed on 22 October that Shopee shipments have **not been
recorded in POS/AdaSmart**. The shadow accepts that statement as an explicit private
input policy, not as a database fact or global setting. A dispatched line moves from
provisional reservation to shipped-unposted demand; it does not disappear or get
deducted twice. Subsequent verified POS issues require reconciling that policy.
The current email reader does not manufacture dispatch events from shipment-due
emails. It also does not infer a historical baseline from the owner statement.
`stockCutoverVerified` remains false: do not deduct the entire historic backfill
from today's POS or Hourly stock.

## Cross-check against the existing sales-summary page

The calculation backing `/shopee/sales-summary` uses `getVerifiedUnitsPerSale`.
Where that returns no verified multipack, `resolveSalesQuantity` returns the
listing order quantity with multiplier one. The resulting number does not carry
proof that it is in the POS base unit. Verified pack counts also need their unit
frame: two retail packs may be one hundred POS pieces, rather than two pieces.

The current summary calculation was checked against current `origin/main` and
replayed privately for all 212 SC catalog records. There are 78 verified pack
expansions and 134 multiplier-one paths. Of the 208 records mapped by this shadow,
193 have the same numeric count and **15 require a different physical base-unit
count**. Four remain withheld. Numeric agreement alone is not independent unit
proof. The existing summary route, copy workflow and displayed totals are unchanged
by this PR; it must not be used as a stock ledger or as proof of POS booking.

## Real read-only audit on 22 October 2026

Executed on SCPRODUCTDEV using the existing Windows identity, existing SQL readonly
account on SERVER004/AdaAcc and existing central read credentials. Source queries
read only product/unit metadata, not stock quantities; no new access was created.

- The SC catalog has **212 listing/variation records**, initially referencing 130
  company SKUs. All 130 exist and are active on POS 004.
- Including the existing reviewed quotation-copy mappings expands the metadata
  check to **208 distinct SKUs**. All 208 exist and are active. None of these audited
  SKUs is a shared-stock alias; alias behavior is covered by simulation, not claimed
  as a live Shopee shared-alias test.
- The initial audit withheld 116 of 212 listing/variation records. After restoring
  reviewed base-unit/pack contracts and normalizing physical contents, **208 map and
  four remain withheld**: three ambiguous physical quantities and one financial
  consolidation with no reviewed physical stock components. This resolves 114 of
  the original 116 and withholds two previously accepted records after exposing
  their unresolved physical-unit ambiguity. No new SKU assignment is invented. It is not a certificate
  that every historical email line has a catalog match.
- At **18:38 Asia/Bangkok**, the growing current email snapshot audit evaluated
  **4,310 orders**, with complete mappings for 4,187; **290 require review** including
  lifecycle limitations. Mapping and lifecycle counts overlap. In addition to the
  four catalog holds, old email item identities outside the reviewed catalog still
  need mapping; 113 orders include that reason. No current-email dispatch states
  were inferred from shipping reminders.
- Existing readonly POS searches over quotations, invoices, sales orders and cashier
  headers found no exact known Shopee order references in the allowed 15 September–
  22 October scope. This is consistent with the owner statement, not proof that
  a timestamp-near document is linked. Actual verified POS issue links supplied: zero.
- Replaying that exact real snapshot with every order and event duplicated produced
  identical private reservation positions. Source application DML: **0**. Central
  shadow writes: **0**. No quantities or business identifiers were saved in evidence.

These are observations of a growing backfill, not a complete live Shopee inventory.
Historical confirmed/shipment-due emails must not all become current reservations:
complete current dispatch/cancellation status, unposted shipment coverage and an
audited stock cutover are still needed. Do not require fictional POS links for a
workflow that has not posted Shopee; establish real links when POS posting begins.
The shadow result is **PARTIAL** and `eligibleForLiveStock` is always false.

## Validation and remaining release gates

Local tests exercise duplicate replay, out-of-order backfill, cancellation ambiguity,
partial and repeated POS issues, stock-basis mismatch, return/refund behavior, unit
and SKU conflicts, shared stock, bundle components, scopes, read-only rollback,
input caps and aggregate-only reporting. A real-source snapshot replay is separate
from these simulations. Windows checkout line endings in an existing unrelated
workflow assertion were normalized locally to match Linux CI; no workflow change
is included in this PR.

The repository CI regression profile passed locally: 104 suites / 1,198 tests,
with 11 database-dependent suites / 31 tests skipped. After the final parser
guards, the four focused shadow suites passed all 98 cases. An additional local
full-suite attempt included the separate backend-startup integration suite; its
36 HTTP cases could not start the migration-dependent server without an isolated
test database. This is the same suite explicitly excluded by the repository CI
command, not a passed integration claim. GitHub CI remains the release check for
its isolated PostgreSQL tests. No test was run against production migrations.

Before any future live stock integration:

1. Finish and verify email recovery, and reconcile current orders with Seller Centre
   and official report coverage. Ingestion freshness alone is not status completeness.
2. Resolve the three physical-unit ambiguities and the financial-only listing,
   then map historical item identities outside the reviewed listing catalog.
3. Establish a stock cutover and current unposted shipment coverage. If/when Shopee
   is booked in POS, establish exact order -> POS issue -> selected stock-basis
   links. Account for older orders before seeding an authoritative ledger.
4. Review one canonical persistent ledger/activation design and test restarts,
   concurrent input and durable idempotency separately. This in-memory shadow is
   not that durable writer.
5. Review shadow comparisons for real confirmed/cancelled/shipped/returned cases.
   Physical returns and refund-only cases must remain distinct.
6. Only a separately approved PR may wire the available-to-sell calculation to the
   website. Keep source/basis times and incomplete data visible. Do not claim atomic
   snapshots, guaranteed clock synchronization or complete business freshness.

Rollback of this prepared shadow is simply to stop invoking the offline reader/CLI.
No production setting, database migration or website quantity needs reverting.
