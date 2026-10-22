# Branch 004 Shopee stock reservation shadow

This change prepares the calculation and evidence contracts for the shared branch 004
stock pool. It does not register a route, worker, timer, migration or activation flag.
It does not change branch-stock quantities, POS, Hourly, Full Sync, Transfer Delta,
the Gmail importer, or the existing quotation/accounting workflow.

## What can run now

- `shopeeStockProductMatch.js` combines the existing exact catalog and reviewed
  quotation-copy pack evidence. Conflicting SKU, pack-count or unit authorities
  remain unresolved. Accounting consolidation is not a physical stock mapping.
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
2. Require a positive integer sale quantity and a verified per-sale pack multiplier.
   An ordinary catalog SKU without unit evidence does not prove one base unit.
3. Compare the evidenced sale base-unit label with the live POS unit dictionary.
   No factor is guessed from a similar name, product-title contents, price or barcode.
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
- Final conservative listing audit: **96 have verified units; 116 are withheld**.
  Reasons include missing unit evidence (88), differing POS units (18), conflicting
  mapping evidence (7), unresolved quantity rules (4), and visibility-only handling (1).
  These are component/reason counts and overlap; they must not be summed as distinct listings.
- At **17:39 Asia/Bangkok**, the current email snapshot audit evaluated **1,299 orders**,
  with verified mappings for 1,036. **296 orders require review**, including lifecycle
  and POS-link limitations in addition to mapping. These counts overlap by reason.
- Replaying that exact real snapshot with every order and event duplicated produced
  identical private reservation positions. Source application DML: **0**. Central
  shadow writes: **0**. No quantities or business identifiers were saved in evidence.

These are observations of a growing backfill, not a complete live Shopee inventory.
Historical confirmed/shipment-due emails must not all become current reservations:
complete current dispatch/cancellation status and POS issue links are still needed.
The shadow result is **PARTIAL** and `eligibleForLiveStock` is always false.

## Validation and remaining release gates

Local tests exercise duplicate replay, out-of-order backfill, cancellation ambiguity,
partial and repeated POS issues, stock-basis mismatch, return/refund behavior, unit
and SKU conflicts, shared stock, bundle components, scopes, read-only rollback,
input caps and aggregate-only reporting. A real-source snapshot replay is separate
from these simulations. Windows checkout line endings in an existing unrelated
workflow assertion were normalized locally to match Linux CI; no workflow change
is included in this PR.

Before any future live stock integration:

1. Finish and verify email recovery, and reconcile current orders with Seller Centre
   and official report coverage. Ingestion freshness alone is not status completeness.
2. Resolve the withheld unit/pack evidence and mappings without guessing conversions.
3. Establish verified order -> quotation/dispatch -> POS issue -> selected stock-basis
   links. Account for any orders already issued, including older orders, before
   seeding an authoritative reservation ledger.
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
