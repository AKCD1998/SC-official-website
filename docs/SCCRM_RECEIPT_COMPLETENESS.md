# SCCRM-first completeness and reconciliation

The cashier's claim and its private completeness job commit together. Missing
unit/barcode/name fields remain visible history while a headless HQ worker reads
final native branch/HQ snapshots. Existing member/bill identity, SKU, sequence,
quantity and every nonempty value must agree. Empty fields and exact appended
rows can be repaired; a footer discount requires independent balanced arithmetic.
Otherwise the queue records review instead of guessing. Ada alone owns points.

The worker has one authenticated internal API and no browser database grants.
Completeness leases are fenced, expire, survive restart and deduplicate lost
acknowledgements. Every success schedules another audit in ten minutes; transient
errors retry with a five-minute cap. Conflicts remain visible with an explicit
retry action. Old eligible claims without jobs start under review until a live
read passes. No native sale is created, no owner is transferred and no points
are credited by this feature.

`completeness_audit` retains both snapshots and original mirror evidence. Old
claim/line IDs and requests are kept. Changed native requests use increasing
revisions, and old acknowledgements cannot finish them. The existing history
list/detail includes a separate completeness result and verification timestamp.
Unchanged periodic checks do not repeatedly grow the immutable event log.

The migration defaults control.enabled=false. Enable only approved pilot claim
IDs first, then remove the allowlist after verifying those real destinations.
Set completeness_control.enabled=false to stop new verification leases without
pausing membership or ordinary receipt delivery. In-flight bounded reads may
finish. Keep audit and filled history during rollback; do not undo native owners
or delete receipt/point rows. The matching native service instructions and copy
tests are in SCCRMonPOS sync-agent/receipts/COMPLETENESS.md.
