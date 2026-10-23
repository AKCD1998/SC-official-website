# Shopee 004 recovery candidate

This is a candidate code/schema change, not a production activation record.
It extends the existing durable ledger and dirty worker. It creates no second
reservation ledger, POS writer, scheduled task, opening plan or cutover.

## Failure boundaries

- Each order projects inside a savepoint. A failed projection cannot partially
  replace a position, release a held line or erase its dirty work.
- Retryable database/transport codes receive five total attempts with waits of
  2, 10, 30 and 120 seconds. The attempt budget belongs to the dirty revision and
  persists across worker restarts. Exhausted work remains visibly blocked.
- Missing source rows, invalid unit contracts and unclassified failures do not
  receive automatic semantic retries. A genuinely new source/rule revision may
  wake the existing queue; merely restarting the worker does not reset it.
- A lost database connection may prevent persistence of that failure. The
  existing worker then uses a per-process circuit: five bounded attempts,
  followed by a five-minute cooldown. Restarting the whole process resets this
  outer circuit, but does not reset any committed per-order attempt state.
- One pass handles at most 25 orders and checks an elapsed one-second budget
  before starting another. An already-running query can still consume its
  existing ten-second statement limit. There is one mapping refresh and one
  bounded identity recovery pass; passes never overlap.

## Meaning and identity

Mapping repair and physical lifecycle approval are separate actions. The normal
worker rechecks the source, original item snapshot, retained holds, immutable
opening boundary and any existing physical reviews. A repaired mapping cannot
approve cancellation, dispatch, a sellable return or an old baseline.

Affected products include the union of the current source, retained original
items and held stock codes. A verified bundle identity fences all its component
products even when a quantity still needs evidence. A wholly unknown order
remains unallocated: known POS/commitment quantities may be references, but are
not certified available stock and unknown quantities are never changed to zero.

A changed rule cannot silently rewrite an already-held stock code, unit or
ordered multiplier. Such a position retains its old lines and becomes
`mapping-held-contract-changed-needs-review`. Revoking a rule appends history and
queues affected work; it does not delete old reservations. Durable identity
recovery jobs resume bounded exact-identity scans after a restart.

## Operator exception read model

Exceptions use opaque UUIDs and optimistic opaque revisions. Public admin
responses contain bounded item/unit metadata, reasons and recovery status, not
order numbers, customer identities, raw emails or provider exception text.
Private context stays inside a server transaction. Mapping approval should use
that same transaction for revision validation and rule/audit insertion.

`reconciliation()` is a read-only preparation report. Its
`physicalStockVerified=false` means this software report is not a physical stock
count. It exposes the preserved cutover, opening basis quality, reserved/shipped
and review counts and whether reconciliation is required.

Before a new physical count is used as the stock basis, an administrator must:

1. Confirm the physical-count time and scope independently.
2. Identify which old shipped-unposted/opening deductions the new count already
   includes; account for each exactly once.
3. Carry only still-valid pending reservations and separately review returns or
   parcels with uncertain dispatch evidence.
4. Review and approve a separate count/cutover reconciliation with an immutable
   before/after record and a recovery plan.

This candidate does not perform that count transition, post anything to POS,
clear historical balances or move the original cutover automatically.

## Verification and release

Synthetic tests use an isolated local PostgreSQL schema, including a real SQL
statement timeout, concurrent ingestion during a failed projection, worker
restart, repeated events, mapping repair with unresolved cancellation and an
old held multiplier conflict. These establish implementation behavior under
those inputs; they do not certify the next production event or physical stock.

Migration 035 is owned by the release coordinator and must be reviewed together
with these callers. Existing readers remain compatible with additive columns.
Do not drop the columns/tables or erase audits to roll back code. Before any
rollback, inspect pending/blocked work and approved rule dependencies; reverting
to the former worker also restores its unbounded poison-order selection.
Production migration, privileged approval bridge activation and behavior
changes require their own reviewed release authorization.
