# Final Ada receipt snapshots and bounded recovery

The desktop must not treat a positive header and a nonempty detail list as a
complete sale. Ada may apply promotions and bill discounts after item entry.
The new reader requires a paid/final document, all payment rows whose net sum
matches the Ada grand total, and two identical observations. Confirmation
re-reads the receipt instead of submitting its cached preview. Ada owns amounts
and points; this integration does not reconstruct promotion prices.

This is a conservative consumer contract, not a claim that one vendor status
flag proves an atomic HD/DT/RC commit. The exact vendor write ordering remains
subject to the ADA rebuild evidence review. Native document time is described
as the time recorded by Ada, not independently proven tender-completion time.

Eight approved historical receipts have exact saved prefix lines, fifteen
missing suffix lines, and two changed header discounts. One legacy imported
mirror already has all SKU/quantity rows but zero amounts and a missing POS;
its identity and every line must match the independently verified final native
receipt before recovery. Neither a different member nor a conflicting nonzero
mirror amount qualifies. The old internal feed now preserves claimed mirrors.

`sccrmReceiptRecoverySql.build` produces the exact operator SQL exercised on
copies. It locks and compares the complete before records, appends only missing
claim lines, repairs only the separately proven zero-valued imported mirror,
keeps existing item IDs and point rows, and writes an immutable private audit.
It never creates an Ada receipt, alters native prices, or awards points.

Native delivery revision 1 and its payload/hash stay unchanged. Revision 2 has
new operation IDs, and expired acknowledgements/manual retries cannot make an
older revision current. Both origin and HQ still use the existing exact native
receiver and journal. Repeat recovery returns the same audit instead of adding
another claim, line set or delivery revision.

Acceptance on 2026-11-12: sixteen PostgreSQL integration tests; eight real
receipt copies recovered twice with all 55 existing point rows unchanged;
sixteen origin/HQ native copy targets checked twice with outer rollback;
sixteen final SQL reads through the actual desktop reader. Local personal
fixtures and before/after records are ignored evidence, never committed.

Deployment order: reviewed backend and private additive migration, then the
approved guarded operator packets, then verify both native targets and public
history. Desktop publication/fleet commands remain gated on the vendor review
and all-case acceptance. No SQL Server, AdaPos or Shopee restart is required.
Software rollback retains revision/audit rows and completed member links;
never delete old operations or reverse a customer's bill association merely
to roll back application code.
