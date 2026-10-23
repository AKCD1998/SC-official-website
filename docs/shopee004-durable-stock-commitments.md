# Shopee 004 durable commitments — preparation, not activation

This change turns the PR85 mapping/shadow policy into one durable marketplace ledger in the SC-official database. It does not write POS quantities, PaaS stock snapshots, Hourly evidence, Full Sync or Transfer Delta. Its feature switch defaults OFF. The PaaS consumer and StockDay UI are separate dependent PRs.

## Quantity contract

For the selected POS basis, `004 available = POS quantity - reserved - shipped but not posted in POS`. Confirmed demand is persisted once per shop/order/product. Shipping moves demand between buckets; it does not remove demand. Negative availability is retained. The current owner-confirmed workflow is **Shopee is not recorded in POS/AdaSmart**. Changing that workflow, or performing a stocktake that incorporates these goods, requires pausing this overlay and reconciling the exact affected stock basis first. This PR does not invent a POS issue link or retire demand on a date comparison.

The 212 reviewed listing variants use the existing PR85 matcher and independent POS base-unit contract (208 products). Keep bounded POS master names: pack-content rules use them in addition to unit labels/factors. The four owner-confirmed retail packages keep factor one; the Strepsils source-label mismatch remains documented. Unknown new SKUs, item edits, missing confirmation/time, unit conflicts and ambiguous physical lifecycle go to review. Existing holds survive a failed re-projection.

An email cancellation alone cannot prove goods were not dispatched; a refund/return notice cannot prove goods physically returned. Human admin decisions record verified pre-dispatch cancellation, dispatch, and sellable quantities actually returned. Partial returns release only the verified unposted quantity. Duplicate operations are idempotent; conflicting re-use or over-returns are rejected transactionally. No guessed TTL or automatic expiry is introduced.

## One cutover, including physically verified pending orders

1. Finish/check email ingestion and review the current inbox against actual unshipped packages. Email status alone is not physical evidence: an old confirmation can still be the latest email for an already shipped order.
2. Supply the explicitly selected, physically verified pending orders and a fresh read-only POS metadata contract in a **private** plan input. Other historical orders are recorded as excluded from new deductions. Historical shipped-but-unposted goods must be reconciled into the opening stock basis separately; this system does not silently deduct all backfilled orders.
3. `plan` validates the selected items/units and saves their exact current snapshots. Its approval identifier is saved privately, not printed. No reservations activate yet.
4. After physical pending review, opening-basis reconciliation, email-feed verification and confirmation that Shopee is not posted in POS, `activate` accepts the saved plan identifier and those explicit attestations. It rechecks the selected snapshots and refuses a changed/incomplete plan. The DB clock fixes the cutover at this activation, once only.
5. Only the approved opening orders and source orders created/confirmed after that cutover enter new commitments. Mail ingestion time is never used as the order-creation time. Late old orders cannot become new deductions: previously unknown historical arrivals require opening review, and the availability view stays unqualified until resolved. There is no backdated cutover or automatic historical replay.

The table trigger takes a shared control lock while the activation takes an exclusive lock. In-flight source writes either precede the reviewed snapshot or queue after activation. The dirty queue is in the same source transaction. Workers use row locks/SKIP LOCKED, and position/lines/audit/queue acknowledgement commit together. Restart and concurrent ingestion cannot acknowledge unfinished work or lose a later revision. Paused ledgers continue to retain/process evidence but cannot advertise availability.

## Reviewable release sequence

### Owner-accepted estimated opening (23 October 2026)

When the owner explicitly accepts a reviewed opening workbook as approximate,
`plan` can additionally receive `openingBasis`. This is a distinct audited mode;
it does **not** assert a physical count or that old shipments were posted in POS.
The original physically verified opening path keeps its original attestations.

The estimate includes a timezone-qualified source cutoff and period start,
the explicit historical shipped order references, positive per-POS-unit totals,
and the number of physical-review exceptions the owner accepted as excluded.
The server maps the referenced inbox items again and requires the totals and
units to match. The historical set must be disjoint from opening pending orders
and within the stated source window (September is not silently reintroduced).
Only aggregate totals, provenance, acceptance identity/time and exception counts
are stored as the opening offset. No migration or POS/sync write is needed.

Activation of this mode requires `ownerAcceptedOpeningEstimate=true` separately
from `emailFeedChecked` and `unpostedPosWorkflow`. Do not set
`openingOrdersVerified` or `olderShippedReconciledInPosBasis` to true merely to
activate an estimate. An ordinary plan cannot use the estimate flag to waive
its physical evidence requirement. The saved cutover and accepted basis remain
immutable; duplicate activation, late old emails and worker restarts do not add
the offset again. New reservations are added independently after cutover.

The projection includes the accepted historical quantity in shipped-but-unposted
demand and reports `openingBasisQuality=owner-accepted-estimate`, source time,
covered historical order count and `openingBasisPhysicalStockVerified=false`.
This is a fixed accepted opening adjustment, not an automatic historical replay.
Historical refunds do not automatically reduce that adjustment. When a physical
stocktake/POS adjustment incorporates these goods, pause and reconcile the basis
before resuming, so the same old shipments are not deducted twice.

**Do not merge/deploy/activate as part of this preparation task.** SC's Render service auto-deploys `main` on commit, and startup applies Seamless migrations. Before a later authorized merge, fetch/recheck the migration ceiling, inspect the SC ledger read-only, and review the exact pending files. This PR adds only `034_shopee004_durable_stock_commitments.sql`; it creates new ledger tables, two scoped email-source triggers, and one scoped index. It seeds no control row and re-runs safely. No PaaS migration is required.

Later authorized order: SC producer code/schema (flag OFF), PaaS consumer code (flag OFF), StockDay UI, dedicated projection credential on the two backends, producer flag ON, private opening plan/review/activation, drain/check queue, then PaaS availability flag ON. Never reuse Sync, Delta, browser or generic internal credentials for the bridge. No secret belongs in a VITE variable or client bundle.

Server-only variables:

- SC: `SHOPEE004_STOCK_LEDGER_ENABLED=false` by default; `SHOPEE004_STOCK_PROJECTION_TOKEN` (dedicated read-only random secret, at least 32 bytes); `SHOPEE004_STOCK_ADMIN_ORIGINS` (exact trusted admin frontend origins, no wildcard).
- PaaS dependent PR: `FEATURE_SHOPEE004_STOCK_AVAILABILITY=false` by default; matching `SHOPEE004_STOCK_PROJECTION_TOKEN`.
- Operator process only: `SHOPEE004_ADMIN_USER` / `SHOPEE004_ADMIN_PASSWORD`, using existing human admin credentials. Do not put them on the command line, in chat, or in tracked files.

## Single operator tool

Run from `backend` with Node. This is not a Scheduled Task and never requests Gmail sync, POS SQL capture, upload, Full Sync, Transfer Delta or rebaseline.

```powershell
node scripts/shopee004-stock-control.cjs status
node scripts/shopee004-stock-control.cjs review-queue --receipt <new-private-review-page.json>
node scripts/shopee004-stock-control.cjs plan --input <private-plan.json> --receipt <new-private-approval.json>
node scripts/shopee004-stock-control.cjs activate --input <private-activation.json>
node scripts/shopee004-stock-control.cjs status
node scripts/shopee004-stock-control.cjs review --input <private-physical-review.json>
node scripts/shopee004-stock-control.cjs pause
node scripts/shopee004-stock-control.cjs resume --input <private-workflow-reconfirmation.json>
```

Private plan input: `openingOrderNumbers` (explicit list, including empty only if physically verified) and `posCatalog` (companySku, stockCode, active, stockFactor=1, smallFactor=1, smallUnit, bounded productName). It must come from an authorized metadata-only read; do not synthesize factors from a listing title. Shared-stock aliases are not auto-admitted; the reviewed Shopee set currently has none.

Activation input: private saved `planId`, `openingOrdersVerified=true`, `olderShippedReconciledInPosBasis=true`, `emailFeedChecked=true`, `unpostedPosWorkflow=true`. These are accountable human attestations, not evidence inferred by software. Do not assert them merely to bypass a stop.

The saved approval file starts with all four attestations **false**. After reviewing the evidence, use that same file for `activate`; there is no need to copy an identifier through chat. Keep input/approval files in an existing private operator folder (Windows inherits that folder's ACL; Node's Unix file mode is not a Windows ACL guarantee). This tool does not change ACLs.

The bounded review queue writes order references/reasons only to a newly created private file; console output stays aggregate. If another page is needed, provide its saved cursor through `--input` and another new receipt file. Order references are not put in a URL, log or chat. Source-label exceptions approved by the owner remain visible as warning counts in status and the consumer UI; they do not become a claim of clean source labelling or business freshness.

Physical review input: private operation UUID, private order reference, `kind` (`cancel-before-dispatch`, `dispatched`, `returned-sellable`, `legacy-in-baseline`), `physicalEvidenceVerified=true`, `notPostedInPos=true`; returns also need productCode/positive integer quantity lines. Retrying the same reviewed operation is safe; never generate another identifier to bypass a conflict. Resume requires `unpostedPosWorkflow=true` and `openingBasisStillValid=true`; it preserves the existing cutover and all holds.

Human admin routes are under `/api/app/shopee/stock-commitments`. Writes require a real admin session/Basic identity, JSON, action header, and an allowed Origin for browser requests. Default-open and generic internal-token authentication cannot mutate this ledger. The dedicated projection token reaches only `/api/internal/shopee004-stock/projection`, a bounded fixed-004 read operation with no order/customer data in its response. Status/tool output contains operational aggregates only.

## Acceptance and stop

Before enabling the PaaS view: producer mode live; dirty/review counts zero; approved opening count checked; actual new confirmation reserves once; actual physical cancellation/return releases only verified demand; restart replay unchanged; page/export subtraction matches ledger aggregates; other branches and existing POS-only API unchanged. Verify current natural Hourly/Full Sync/Delta results independently without triggering work. Tests cannot guarantee future email completeness or physical events.

On a problem, `pause` keeps holds and makes the optional view unknown. Do not delete control/claims/ledger, reset the cutover, clear a queue, release all holds, or switch back to unadjusted numbers and call them available. Code rollback must retain the additive schema; keep the consumer blocked until an audited replacement can honor the commitments. POS Hourly/Full Sync/Delta continue independently.

Email latency and missing/non-email orders remain visible limitations. Ledger snapshot consistency does not make the earlier POS NOLOCK observation atomic. The API reports the POS basis time, ledger snapshot time and latest ingested email time; none is a business freshness guarantee. Replenishment/credit commitments and future exact POS issue reconciliation are separate work, not secretly added to this change.

## Existing reservation designs

The two old local `071` stock-request candidates concern donor-capacity allocation and have conflicting TTL/lifecycle models. Neither is reused, renumbered or merged. Shopee orders are external confirmed demand and can oversell; they are not internal stock-request holds. This SC ledger is the sole authority for Shopee commitments, and PaaS only reads it. A future canonical stock-request design must consume this encumbrance rather than create a second Shopee reservation or reapply deductions through Full Sync/Delta.

### Late historical emails with an accepted estimate

For an explicitly owner-accepted estimated opening, an order arriving later with a
creation time before the immutable cutover is excluded from additional deductions
and retains the warning `late-legacy-excluded-under-owner-accepted-estimate`.
This is not evidence of a physical count or a POS adjustment. Its aggregate count
is exposed separately from source-label mapping warnings. Unknown dates and
previously admitted new orders remain subject to review.

The human-admin `POST /api/app/shopee/stock-commitments/reconcile-accepted-legacy`
action, with `ownerAcceptedOpeningEstimate: true`, can requeue up to 500 existing
legacy-only opening reviews after upgrading the rule. It cannot requeue an order
with held quantities, another review reason, a missing date or an order created
on or after cutover. It preserves the opening offset and cutover and records no
claim that stock was physically verified or posted in POS. Ordinary physically
verified opening plans continue to require explicit review of late old arrivals.

### Reviewed stock-mapping upgrades

The existing maintenance worker checks at most 50 mapping-only review positions
once per 30 seconds. It requeues a position only when all current items pass the
reviewed stock/unit mapper. Normal projection then checks lifecycle and retained
item changes again. This adds no cancellation, dispatch, return or physical-count
approval, and does not move cutover or rebuild the opening basis. Unresolved or
mixed review reasons stay blocked. The worker does nothing while its feature is OFF.
### Per-product review qualification (23 October 2026)

The internal projection declares `availabilityContract: per-product-review-v2`.
A single repeatable-read snapshot maps every queued/reviewed order's current
items, retained original items and held stock codes. Fully verified scope marks
only those products `review_required`; other requested products remain available.
Exact catalog identity can fence a product even while its quantity/unit is
unverified. An order with no verified identity is counted in `unallocatedOrders`;
other unfenced records become `known-commitments-only`, never `available`.
Consumers may display their existing known deductions as temporary quantities,
with a visible incomplete-order banner and explicitly qualified Excel values.
They must not imply those orders were deducted or release retained holds.
Missing source data, a queue above 100 orders, or a paused control still fails
closed for the response. A unit/quantity conflict quarantines only its product
with null demand instead of inventing zero. No cancellation, return, physical evidence or
opening-basis approval is inferred from scope qualification. Existing holds,
immutable cutover and accepted opening estimate are preserved.

The exact ALSOFF blue 450-ml single-bottle variant is independent from the
six-bottle pack. Seller Centre explicitly describes one bottle per selected
formula; the existing verified POS bottle identity is reused with factor one.

The SOS S 2x6-inch / 10x20-cm variant is one POS box containing two dressings,
verified against Seller Centre and fresh read-only SERVER004 metadata. The
human-admin action `extend-pos-catalog` appends up to 50 validated unit contracts
and rejects every change to an existing contract. It preserves cutover, opening
plan and quantities. The existing throttled worker also rechecks an exact
`pos_product_missing` review after an append, with no lifecycle approvals.
