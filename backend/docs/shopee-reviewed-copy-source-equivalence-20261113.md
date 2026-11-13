# Reviewed Shopee copy lines across rolling exports

An accounting review could identify the existing ERP SKU and pack, while the
live copy planner continued to hold the line. Some previous reviews were bound
to an older workbook hash/row, and seven renamed variation contracts ended on
5 November. A later rolling export moved those same orders to different rows.
The UI correctly kept its copy buttons disabled while these holds remained.

The existing accounting registry now carries 63 reviewed source contracts for
370 independently checked source lines. They use existing ERP codes and base
units; one contract has separately owner-confirmed Smart-kit contents. They
are accounting-only and do not enter the physical stock matcher or lifecycle
registry. No customer names, order identifiers, raw workbooks or source prices
are stored in these contracts.

`shopeeReviewedCopyLines` binds each review to a SHA-256 of its exact order and
line meaning: shop, order number, creation/payment timestamps, selected title
and option, source identifiers/SKU, quantity, unit price, order components and
source line financial components. The original reviewed workbook hash/row is
retained as provenance. A later source file may move the row without losing
that review. A new order, changed pack, changed amount, missing source identity
or contradictory identifier cannot borrow it. Existing generic matching and
variation-period holds still decide every unreviewed line.

The registry stores independently evidenced active ERP metadata, smallest-unit
factor one and base barcode for each component. Existing accounting master
units must agree. Duplicate proofs, duplicate components or missing metadata
block resolution. The complete registry participates in the matching digest.

Reviewed multi-SKU identity still requires a separate exact enabled allocation
in the existing private policy ledger. The new owner-confirmed Smart 100-needle
set uses one meter box (with ten included strips), one additional 50-strip box,
and two 50-needle boxes. It does not borrow the old 50-needle factor. The existing
primary-product/nominal-secondary-line method retains the original set amount:
at 500.00 THB, meter 499.80, additional strips 0.10, and both needle boxes 0.10
in total (0.05 per ERP box). Approval/source receipts stay outside Git.

Read-only frozen-input replay of 5–12 November reproduces the prior 378 holds
before the change. With the reviewed identities and the exact proposed policy,
all eight daily plans and the range are ready: 3,724 paid orders, 4,902 source
lines, 357 copy rows, 1,252,380.00 THB and zero variance. All 4,686 previously
supported source allocations preserve their SKU quantities and original source
amounts. This is replay evidence; production acceptance must verify the released
commit and actual copy buttons/clipboard separately.

Synthetic regressions cover rolling hash/row changes, new orders, changed money,
timestamps, SKU/IDs/barcodes, shared-SKU 1/10/12-bottle packs, invalid ERP metadata,
duplicate proofs and the exact Smart allocation/positive needle-box prices.
Rollback is a code revert plus disabling only the separately added private
100-needle policy. No Shopee source facts, BI, ERP masters, AdaSmart documents,
stock reservations or posting state are changed.
