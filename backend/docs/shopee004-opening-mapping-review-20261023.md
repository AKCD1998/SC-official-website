# Shopee 004 opening mapping review, 23 October 2026

This change adds 69 exact name/variant stock rules. It does not modify the
general product matcher, accounting copy rules, email importer, Hourly reader,
Full Sync or Transfer Delta. It adds no migration or activation operation.
The producer ledger and availability consumer remain OFF.

## Evidence

- Frozen Seller Centre all-orders export created 1–23 October, downloaded at
  10:20 Asia/Bangkok on 23 October: 4,924 orders / 5,721 item lines.
- Inbox orders and lifecycle events read in a read-only consistent transaction.
- SERVER004/AdaAcc product and unit metadata read with the existing readonly
  identity, without stock balances or writes. All 59 specifically queried SKUs
  existed and were active; merged metadata covers 241 relevant SKUs.
- Existing independently reviewed physical copy rules and POS base units.
- Seller Centre descriptions and package images inspected directly. Individual
  evidence URLs and explanations accompany the added late-resolved rules.
- Owner confirmed the max III standard kit **plus an additional 50-strip box**.
  The standard kit already includes 10 strips; consume one kit, one 50-strip box
  and two independently identified 50-lancet boxes. Do not unpack/subtract the
  kit's built-in strips again.

Only exact identities are accepted. New variants, conflicting supplied IDs/SKUs,
unreviewed barcodes and changed POS units remain blocked. Source names are not
rewritten and there is no fuzzy match or price-based pack inference. A historical
PU size-label discrepancy and the previously owner-confirmed Strepsils label
discrepancy retain `sourceLabelMismatch` warnings.

## Local shadow result (not a production activation)

| Frozen export subset | Before technical review | Remaining |
| --- | ---: | ---: |
| Pending, 153 orders | 53 mapping/unit holds | 0 mapping/unit holds |
| October dispatched-review, 4,337 orders | 548 review orders | 43 physical/lifecycle reviews |

The 505 cleared dispatched-review orders bring the technically reconciled total
to 4,294. The remaining 43 consist of 16 return/refund orders and 27 canceled or
nonfinal orders with a dispatch timestamp. These require actual shipment/return
evidence; a refund does not prove sellable stock returned.

Separately, 221 September-created orders dispatched in October were already
included in the owner's September POS adjustment and remain excluded from a new
deduction. Four canceled orders in that group still require physical-return
review. None of these checks attest physical pending parcels or create a cutover.
The frozen pending set must be refreshed before an eventual opening approval.

## Validation

- 386 tests across 13 targeted stock, ledger-control/routes, general matching,
  accounting copy, automatic-unit and email-parser suites passed.
- Private replay of 412 existing catalog/copy variants: 411 identical; the one
  intended change reuses the existing owner's physical Strepsils confirmation
  for its older historical exact label.
- All frozen pending/dispatched mappings compared to inbox after the changes.
  No source or central stock/configuration writes, imports or replay were run.
- The local opening workbook preserves owner entry columns and keeps physical
  review, September basis exclusions, and unapproved opening quantities separate.

These tests do not prove a future natural run or physical inventory accuracy.
The PR does not authorize merge, deployment, historical stock adjustment or
reservation activation.
