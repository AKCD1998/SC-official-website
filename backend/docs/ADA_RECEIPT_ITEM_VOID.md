# Paid sales with removed items

The POS receipt claim endpoint accepts the original positive item and AdaFront's
`Void - ...` reversal from installed clients. Previously the negative quantity
failed validation and prevented the entire purchase history from being saved.

`normalizeReceiptItems` removes both sides of an exact preceding full reversal.
SKU, name, barcode, unit, price, quantity, net amount, discount and promotion must
match. Matching consumes one original row only; a later re-added same SKU stays
in the purchase. Do not drop only the negative row or aggregate different units.
Unknown negative lines, unproven partial reversals, invalid sequence and receipts
with no remaining items fail before starting a database transaction. Return
document processing is unchanged. A new native document/line-status contract
would be needed before broadening this to other cancellation shapes.

The existing private `receipt_snapshot.lineAdjustments` stores whitelisted source
lines, pair sequence numbers and a policy version. `snapshot.items`, claim item
rows and POS sale mirror rows contain actual sold items. The customer/staff
purchase-history mapper exposes only actual purchases. No schema migration or
rewrite of old history is involved. Ada owns point awards; this normalization
does not calculate or credit an extra award, change receipt owners, or bypass
the transaction/advisory-lock duplicate guards.

## Evidence and verification

- Asked the ADA rebuild chat for read-only guidance. Its Monitor financial SQL
  literals exclude `FTSdtStaPdt` values `4` and `5`; it could not prove that
  `FNSdtStaRef` references a detail sequence. Do not use that field as a pointer.
- Read-only branch 005 receipt `S2611005001-0004290` contains +170, -170, +90,
  +85. Both first rows have status 4; the active rows have status 1. All four
  reference values are 1. Normalized rows are seq 3 (two bottles, 90) and seq 4
  (one bottle, 85), exactly matching native active rows and paid header 175.
- Local real PostgreSQL test saves the history/mirror, reads SKU/unit/quantity/
  timestamp back, retains four private source lines, and rejects repeated claims
  and a different member. Ada-authority route tests independently check zero
  extra point writes and preservation of the native award.
- Tests also cover repeated pairs, same-SKU re-addition, free items, discounts,
  orphan/double/mismatching reversals, oversized identities and malformed input.

The real receipt was read only during investigation. After the server deploy,
the cashier can reload it in SCCRM and confirm history once. No POS reinstall or
AdaPos restart is needed. A sale with no member/award in Ada records history
without independently awarding points.

## Rollback

Revert the receipt-line normalizer/route commit and deploy the previous reviewed
website revision. Keep existing history and JSON snapshots; neither deployment
nor rollback requires deleting purchases, changing Ada data or restarting HQ,
SQL Server, AdaPos or Shopee automation.
