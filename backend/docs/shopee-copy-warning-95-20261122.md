# SC copy warnings on 22 November 2026

## Live incident

The signed-in Seamless page and authenticated backend were checked with the
same SC Drug Store filter the user was using: **12–18 November 2026**.
The pasted HTML and live plan both contain **95 alerts**: 89 product lines and
six daily reconciliation alerts. There are 3,046 orders and 3,948 source lines.
The live eligible table is ฿818,392 against BI ฿853,215, a gap of ฿34,823.

Production is on `7d0c095cf8065640000c0ca83f83557afb0f86e0`, Render deploy
`dep-dbupfo8u01pc73fa9bjg`. It includes #142 and later login/device changes.
PR [#143](https://github.com/AKCD1998/SC-official-website/pull/143) is still open
and has not been merged or deployed. The previously reviewed 21 options are
therefore absent from production. This is a release gap, not evidence that the
approved SKU or pack has changed.

Replaying the original #143 head on the exact current source facts clears 72
of the 89 product lines, including 17 later orders reusing those approvals.
All 3,859 previously accepted line allocations retain their source amount,
business date, SKU, unit, multiplier and attribution. The remaining 17 product
lines require 12 further selected options. Three days become ready once the
product holds are removed; the original 13–15 November differences remain.

## Verified new options

Fresh Seller Centre descriptions and variation/SKU/GTIN exports were downloaded
without editing or uploading a product. POS 004 was queried through the existing
SELECT-only account, with INSERT/UPDATE/DELETE and owner/sysadmin permissions
checked as zero. The existing accounting registry gains the following contracts.
These are proposed runtime rules with verified evidence, pending release review.

| ID suffix | Product / selected option | Lines in 12–18 Nov | Lines in 13–19 Nov | SKU | POS base unit | Multiplier |
|---|---|---:|---:|---|---|---:|
| 01 | Tiger Plaster HR / small 7×10 cm, two patches in a pouch | 5 | 5 | 630020316 | ชิ้น | 1 |
| 02 | Deeday / Night's Story, one retail box | 1 | 1 | IC-005616 | กล่อง | 1 |
| 03 | Centrum Silver / 30 tablets, one retail box | 2 | 2 | IC-000426 | กล่อง | 1 |
| 04 | Centrum Silver / 90 tablets, one retail box | 1 | 1 | IC-000605 | กล่อง | 1 |
| 05 | Tiger Plaster HR / large 10×14 cm, two patches in a pouch | 1 | 1 | IC-002635 | ซอง | 1 |
| 06 | Mybacin Zinc orange / 20 sachets | 1 | 1 | 630010042 | ซอง | 20 |
| 07 | Kleanglove N / powder-free blue S, 100 pieces per box | 1 | 1 | IC-003484 | กล่อง | 1 |
| 08 | Vicks / honey-lemon, eight lozenges per sachet | 1 | 1 | IC-004754 | ซอง | 1 |
| 09 | Vicks / orange, eight lozenges per sachet | 1 | 1 | IC-004755 | ซอง | 1 |
| 10 | Mamarine / blue Omega-3 Original 120 mL | 1 | 2 | IC-001334 | ขวด | 1 |
| 11 | Klean Mask / green, 50 pieces per box | 1 | 1 | IC-006071 | กล่อง | 1 |
| 12 | Kleanglove N / powder-free blue M, 100 pieces per box | 1 | 1 | IC-003483 | กล่อง | 1 |
| 13 | Klean Mask / white, 50 pieces per box | 0 | 2 | IC-002952 | กล่อง | 1 |
| 14 | GHP NasiCare / ขวดล้าง 1 ชิ้น, complete 300 mL kit | 0 | 4 | IC-004143 | กล่อง | 1 |
| 15 | Beurer / HA20 complete retail kit | 0 | 1 | IC-003003 | เครื่อง | 1 |
| 16 | Kangaroo / two 300 mL cans | 0 | 1 | 630020333 | กระป๋อง | 2 |
| 17 | ALSOFF / blue 450 mL, six bottles | 0 | 4 | 630010225 | ขวด | 6 |
| 18 | Kleanglove N / powder-free blue L, 100 pieces per box | 0 | 1 | IC-003482 | กล่อง | 1 |
| **Total** | | **17** | **31** | | | |

Contract IDs are `sc-copy-review-20261122-01` through `-18`. Reuse provenance
is `reviewed-copy-product-option-2026-11-22-v1`. Existing owner confirmations,
including Erbatop and Kangaroo three cans, stay in their existing contracts.

The Mybacin orange GTIN identifies one sachet in POS. Its selected offer and
description explicitly sell a box of 20 sachets. The POS medium quantity is
140 and is not the quantity sold by this offer. Tiger Plaster's two patches
already belong to one retail POS unit. Centrum's 30/90 tablets, Vicks' eight
lozenges, gloves' 100 pieces and masks' 50 pieces likewise remain inside the
verified retail base unit.

Mamarine's description explicitly names the blue Omega-3 formula as Original,
which agrees with POS despite the different short product name. Deeday's
gallery and selected SKU/GTIN identify one retail box of Night's Story, not
the seven-formula gallery as a combined bundle. Package photo hashes are kept
with the evidence.

## GHP approval reuse through the existing ledger

GHP has no Order All or current Seller SKU/GTIN. Its unique Seller option is
listing `55815800400`, variation `426486290447`. The product title is unchanged.
The selected option changed from the already verified `1 ขวด` to
`ขวดล้าง 1 ชิ้น`.

The existing September catalogue rule already identifies the exact GHP
NasiCare automatic 300 mL product as IC-004143, one POS box, with barcode
`8853644004260`. The fresh POS read agrees. The fresh Seller description
specifies one bottle plus the child/adult nozzles in one box; the current
packaging photo independently shows that same complete 300 mL retail kit.

A typed `unique_seller_option_prior_verified_catalog_pos` link binds that
specific prior rule by SHA-256. Reuse requires one unique prior option, its
verified authority/date, unchanged exact product title, SKU, pack quantity,
base unit and barcode, plus fresh Seller rows, POS evidence and package photo.
Disabled/revoked or ambiguous prior approval, changed units/packs/barcodes,
incomplete proof and newly supplied conflicting identities hold the line.

The barcode is established by the prior verified catalogue and fresh POS.
It is **not claimed to be readable from the current package photo**. This path
does not infer a new identity from a similar name or from SKU alone. GEN-DM's
separate packaging-barcode proof path remains required for its own approval.

## Read-only acceptance

| Scope | Production product alerts | Original #143 product alerts | Updated candidate product alerts | Updated candidate total / BI |
|---|---:|---:|---:|---:|
| User's 12–18 Nov view | 89 | 17 | **0** | **฿853,215 / ฿853,215** |
| Additional 13–19 Nov check | 119 | 31 | **0** | **฿843,928 / ฿843,928** |

For the user's view, alerts decrease from 95 to three **in the replay**. The
live page continues to use the deployed code until the reviewed PR is released.
The remaining three alerts are daily financial attribution, not product matching.

| Day | Candidate amount | BI | Difference | Candidate / BI orders |
|---|---:|---:|---:|---:|
| 12 Nov | ฿125,854 | ฿125,854 | ฿0 | 434 / 434 |
| 13 Nov | ฿110,900 | ฿111,932 | −฿1,032 | 366 / 367 |
| 14 Nov | ฿94,671 | ฿94,012 | +฿659 | 353 / 353 |
| 15 Nov | ฿168,807 | ฿168,434 | +฿373 | 550 / 549 |
| 16 Nov | ฿122,299 | ฿122,299 | ฿0 | 466 / 466 |
| 17 Nov | ฿109,253 | ฿109,253 | ฿0 | 411 / 411 |
| 18 Nov | ฿121,431 | ฿121,431 | ฿0 | 466 / 466 |
| 19 Nov, additional check | ฿116,567 | ฿116,567 | ฿0 | 421 / 421 |

The complete 12–18 or 13–19 range remains `review_required` with no copy
columns, because the three daily differences cancel in the range total.
No balancing adjustment or guessed date correction has been made. The
unresolved dates need the independently reconciled daily confirmed-product
evidence described in the existing business-date ledger documentation.

All 3,859 previously accepted allocations in the user's view and 3,837 in
the additional scope retain their exact SKU, unit, multiplier, listing quantity,
source amount, attribution policy and business date. The frozen 5–12 November
regression retains all 4,902 allocations and remains ready at ฿1,252,380.
The frozen 13–17 November result remains ฿605,930 with no product holds and
the same three daily alerts.

## Source custody and tests

| Seller source | SHA-256 |
|---|---|
| mass_update_basic_info_1763530749_20261122180242.xlsx | 13ed753880c5baec59d92f3876d8febbf98f16607f9340c5d8e312f2d2827f05 |
| mass_update_sales_info_1763530749_20261122180527.xlsx | b46cb2652165ae38e882d8198052f45030b9f8644525076a251a25432c97708f |

Private evidence is under `work/copy-evidence-reuse-20261122/private/` in the
investigation workspace. It contains the pasted alert classification, exact
production cohorts, independent expected line outcomes, fresh Seller rows,
SELECT-only POS captures, packaging photographs, and current/baseline replay
results. The source workbooks remain unchanged in Downloads. Raw order
identifiers and source workbooks are not added to Git.

The local accounting suites pass **328 tests**, with two skipped. Coverage
includes the independently checked pack/unit cases on later orders, SKU
conflicts, incomplete proof, prior catalogue pack/unit/barcode changes,
ambiguous/disabled/revoked approval, and missing-SKU isolation. Full CI is
checked on the final review head separately from these local tests.

Changes are limited to accounting-copy evidence, its resolver/tests and
documentation. Stock, opening balance, permanent cutover, lifecycle, sync,
source dates/financial amounts and AdaSmart data are unchanged.
