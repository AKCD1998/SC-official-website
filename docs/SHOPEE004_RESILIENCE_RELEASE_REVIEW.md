# Shopee 004 resilience: candidate release and rollback

This change extends the existing reservation ledger. It creates no second stock
ledger, changes no opening plan or cutover, and does not write POS data. Mapping
approval, cancellation, dispatch, physical return, and count reconciliation remain
different decisions. No production migration, flag, credential, or quantity change
has been approved as part of preparing this PR.

## Inspected production baseline (23 October 2026)

- SC main includes PR 93; API main includes PR 40; StockDay web includes PR 78.
- Source migration ceiling is 034, with 37 applied files and no pending files.
  Central API ceiling is 075, also with no pending files. Main owns the new source
  migration 035; the API and web changes require no new migrations.
- The existing ledger is live. Its permanent cutover is
  `2026-10-23T06:26:56.146Z`. The opening includes 153 orders and is explicitly an
  owner-accepted estimate, not an attested physical count.
- Hourly/complete-cohort and Transfer Delta remain enabled as previously approved.
  The implementation does not modify Hourly, Full Sync, Delta, source tasks,
  credentials, permissions, cohorts, or onboarding 005.
- SC automatically deploys main commits and runs Seamless migrations before
  listening. The API tracks checked main commits and has `npm run db:migrate` as
  its pre-deploy command. **Merging is a production release**, not a staging step.

## Behavior and limits

Exact listing/variation identifiers and independently verified unit/POS evidence
govern versioned rules. Legacy names remain usable only while trusted evidence
does not contradict them. Fuzzy/name similarity cannot approve units. A changed
catalog or POS unit can fence a previously accepted rule without erasing its hold.

The existing worker owns recovery. Per-order retries persist, stop after five
attempts, and distinguish transient failures from semantic conflicts. Processing
uses a savepoint per order. A source revision or reviewed rule change can wake
the existing queue. Durable, bounded recovery cursors cover current items,
original items, and retained stock codes. Projection fences affected stock before
those cursors complete. There is no new Scheduled Task or independent worker.

Unknown product identity makes Shopee coverage incomplete. POS and known holds
remain separately readable; unrelated products are not certified unaffected.
The companion API retains a bounded, timestamped last-success reference in process
memory, never as current sellable stock. It is lost on API restart until a healthy
read; a durable materialized projection is not included in this release.

An amended rule does not silently change the product, unit or quantity of an
existing nonzero hold. Such cases remain fenced for separate reconciliation.
Likewise a lifecycle decision does not waive a changed held unit contract.

Stock database acquisition is bounded at three seconds with at most four pending
connects per pool. Query response waiting is bounded separately at ten seconds;
the helper destroys a connection whose outcome is uncertain. A lost COMMIT reply
is not treated as a failed/no-write transaction. Human mutations retain their
operation ID for an explicit same-request outcome check; they are never retried
automatically. These limits apply to the Shopee ledger database only, not POS
Hourly collection or the existing Full Sync/Delta readers.

## Catalog audit and prepared metadata

Seller Centre read-only inspection covered 358 listings / 652 variations and
358 descriptions. Read-only POS metadata confirmed 352 requested products.
The private review candidate has 353 consistent bindings, including 39 supported
historical aliases, backed by 1,103 normalized evidence facts. Its 220 distinct
POS products are already present in the current 241-product unit contract.
No catalog extension is required for those bindings.

The other 299 variations remain unapproved: 234 have an exact active POS SKU but
insufficient unit evidence, 62 need identity and unit evidence, and three have
explicit SKU conflicts. Descriptions alone are not promoted to approved unit
facts. The private candidate is not committed or automatically imported by this
PR. No Seller Centre listing is edited.

Catalog drift detection consumes newly verified catalog/POS evidence imports.
This release does not add a continuously authenticated Seller Centre scraper or
claim that a 23 October snapshot detects later shop edits without another import.

The preparation replayed the candidate matcher against an actual, read-only
209-position snapshot: no missing source, state differences or quantity
differences. This was in-memory candidate replay, not a deployed-candidate HTTP
test or a guarantee about the next natural order.

## Review and release sequence (requires explicit approval)

1. Re-fetch all three main branches and recheck exact candidate commits, CI,
   source/central migration ledgers, deployed versions and pending migrations.
   Renumber 035 if another source migration has landed; do not resolve collisions
   by changing the migration ledger. Review 035's exact effects and lock budget.
2. Release the source PR first. Migration 035 only adds recovery columns and
   identity/evidence/history tables to the existing model. Startup must complete
   migration before serving. Keep `SHOPEE004_STOCK_EXCEPTION_ADMIN_ENABLED=false`.
   Verify ordinary ledger processing, unchanged opening and existing quantities.
3. Release companion API PR 41, then web PR 79, with their new administrative
   functionality disabled. Recheck live GET responses, numeric/reference/unknown
   rendering and existing Hourly/Full Sync/Delta invariants.
4. Separately approve provisioning a dedicated review bridge credential into the
   two backends. It must differ from the existing projection READ credential.
   Enable only the new admin flags after the receiving routes and auth/CSRF tests
   pass. Never grant the READ token write authority.
5. Separately approve importing the reviewed metadata candidate through the human
   source-admin endpoints. Import evidence in bounded batches (maximum 200 facts
   and 480 KB serialized per request; the exact path has a 512 KB parser), then
   apply individual catalog approvals with a stable operation journal and current
   expected catalog/rule versions. The 299 unresolved variations stay unapproved.
   Do not bundle mapping approval with cancellation, dispatch or return evidence.
6. Observe recovery on the existing worker. Verify queue cursors finish, unchanged
   cutover/opening, retained holds on conflict, no duplicate debit/release, and
   actual StockDay API/browser results. Record aggregate actual outcomes separately
   from local fixtures and read-only candidate replay.

## Before the next stock count

Use the read-only reconciliation endpoint and exception queue to prepare separate
lists of reserved demand, shipped-but-unposted demand, and unresolved held-unit
contracts. Preserve the permanent cutover and original opening. Reconcile which
outbound items are already covered by the physical count/POS basis; obtain an
explicit, separately audited count/coverage decision before retiring old holds.
Never clear shipped holds merely because an email says delivered, or subtract
opening demand again from a newly counted basis. This PR exposes the preparation
and guard rails; it does **not** automate a stock-count cutover or POS posting.

## Rollback

Disable only the new exception-admin flags to stop further rule changes. Keep
existing ledger/consumer/Hourly/Full Sync/Delta flags intact. Do not delete rules,
evidence, operations, recovery jobs, holds, opening or audit history.

Application rollback does not require dropping migration 035: old readers ignore
the additive schema. However an old worker does not understand the new retry and
fencing state. Do not blindly roll the worker back while new recovery jobs or
blocked holds exist. Review queue state and choose a compatible worker build or
an explicitly approved, temporary ledger-processing pause; projections must show
incomplete/stale status throughout. Restore no baseline and run no manual Sync.

## Validation boundaries

Local tests use synthetic events and isolated PostgreSQL. They cover duplicate
and reordered mail, source-time correction, mapping/unit drift, bundles/shared
stock, cancellation/returns, restart, timeout, idempotency, malformed evidence,
read-only enrichment and migration rerun. UI checks use mocked candidate APIs;
live production checks validate the old release and existing operations only.
CI and these tests are evidence of tested paths, not proof of future natural
orders, physical stock, clock synchronization or complete marketplace freshness.
