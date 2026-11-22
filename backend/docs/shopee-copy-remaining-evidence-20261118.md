# SC remaining copy evidence — 18 November 2026

The current 95-alert incident, additional verified options and updated #143
replay are recorded in [the 22 November review](shopee-copy-warning-95-20261122.md).

## Production release of PR #142

PR [#142](https://github.com/AKCD1998/SC-official-website/pull/142) passed its
three checks and was squash-merged as
`3225d911f049c87d257f8f82df78393d7394435c`. The main-branch backend,
security and Pages checks passed. Render deploy
`dep-dbuln1u1egvs73avemmg` reached live at 08:03:13 UTC on 18 November.

The authenticated production API and the signed-in Seamless Sales Summary
page were checked for SC Drug Store, 13–17 November. All 229 reviewed lines
gained their expected allocations and lost their product warnings. The live
page decreased from 289 alerts to 60: 55 product lines and five daily alerts.
The live copy plan remained held at ฿579,084 against BI ฿605,930.

The read-only acceptance compared stock control mode, permanent cutover,
plan and POS catalogue, plus all 49 physical identity rules, before and after.
They were unchanged. This release did not authorize physical stock actions.

## Follow-up evidence and accounting rules

The remaining 55 lines represent 21 exact product/selected-option pairs.
Each pair has exactly one matching option in the fresh Seller Centre export.
Seller product and variation IDs, source row hashes, package descriptions,
GTIN, POS 004 base units and pack factors are retained on the existing
`reviewedCopySourceContracts` entries. No parallel registry was created.

The new contracts are `sc-copy-review-20261118-01` through `-21`. Reusable
accounting matching reports version
`reviewed-copy-product-option-2026-11-18-v2`. These rules are proposed code
for review, with independently verified product facts. They are not deployed
by the PR #142 release.

| Contract suffix | Product / selected option | Source lines | Company SKU | POS base unit | Base units per sale |
|---|---|---:|---|---|---:|
| 01 | Mi-Herb cotton / 7 g | 1 | IC-005829 | ขวด | 1 |
| 02 | AMOGIN EFFE orange / 5 sachets | 1 | IC-005328 | ซอง | 5 |
| 03 | CYBELE Scagel Kids / 9 g | 2 | 630010024 | หลอด | 1 |
| 04 | Klean&Kare / 100 mL pointed bottle | 5 | 630020298 | ขวด | 1 |
| 05 | Kangaroo 300 mL / 1 can | 17 | 630020333 | กระป๋อง | 1 |
| 06 | Beurer / FT09/1 | 2 | IC-001997 | ชิ้น | 1 |
| 07 | Saugella / Poligyn | 1 | IC-000299 | ขวด | 1 |
| 08 | GEN-DM MF vanilla / 2.5 kg, 1 bag | 7 | IC-001444 | ถุง | 1 |
| 09 | Sinocare / iCan i6 CGM | 2 | IC-005860 | กล่อง | 1 |
| 10 | Tiger Balm HR white / 10 g | 1 | 630010095 | ขวด | 1 |
| 11 | Saugella / Attiva | 2 | IC-000300 | ขวด | 1 |
| 12 | Erbatop / pink Moist 9% | 1 | IC-005480 | กล่อง | 1 |
| 13 | Kleanglove N / powder-free black L | 1 | IC-002958 | กล่อง | 1 |
| 14 | Kleanglove N / powder-free black XL | 1 | IC-004185 | กล่อง | 1 |
| 15 | Klean Mask Longmed / black | 1 | IC-002951 | กล่อง | 1 |
| 16 | Tiger Balm HR white / 30 g | 3 | 630010093 | ขวด | 1 |
| 17 | Saugella / Girl | 1 | IC-005287 | ขวด | 1 |
| 18 | Mybacin Zinc honey-lemon / 20 sachets | 1 | IC-004647 | ซอง | 20 |
| 19 | Plaivana / cream 35 g | 1 | IC-001829 | หลอด | 1 |
| 20 | Saugella / Dermoliquido | 3 | IC-000301 | ขวด | 1 |
| 21 | Kangaroo 300 mL / 3 cans | 1 | 630020333 | กระป๋อง | 3 |
| **Total** | | **55** | | | |

A glove box already contains 100 gloves and a mask box contains 50 masks.
Their POS base units are boxes, so neither receives a further piece multiplier.
Tiger Balm and Mi-Herb retail jars use the POS base unit named ขวด.

AMOGIN's Seller GTIN identifies the POS medium pack of five base sachets.
Mybacin's Seller GTIN identifies the medium pack of 20 base sachets. The
glove, mask and sachet distinctions were checked from package and POS
metadata, rather than deriving a multiplier from the listing name or price.

### Owner-resolved conflicts

Erbatop has Seller SKU IC-005480 and GTIN 8858663809186. Its parent title and
description say 60 g, while POS and the actual pink packaging photo say 50 g.
The owner explicitly accepted the matching SKU/GTIN identity and one POS box.
The contradictory size remains in evidence; neither listing nor POS was edited.
This approval is specific to this reviewed identity, not a general permission
to ignore future SKU, unit or pack conflicts.

For the selected Kangaroo three-can option, one affected sale is one set at
฿640, with zero seller voucher and zero Shopee product discount. The current
Seller Centre options were one can ฿220, two cans ฿435 and three cans ฿640.
The owner then explicitly confirmed three base cans per set. Historical
one-can order prices differ from the current listing price. Each order keeps
its own source amount.

The ฿640 sale allocates to three cans without losing a satang. The existing
SKU-wide averaging for this entire date range combines all 31 Kangaroo cans
at ฿6,044: 24 cans at ฿194.97 and seven at ฿194.96. This does not replace any
order's source price or financial attribution. The price-allocation and
averaging implementation is unchanged.

Exact owner responses remain in the private investigation folder. Their
SHA-256 digests and case IDs are recorded on the accounting contracts.

### GEN-DM without an Order All SKU

GEN-DM's source rows have no SKU or native variation ID. The Seller option is
uniquely identified as one vanilla 2.5 kg bag, listing `50117680810`, variation
`376498416655`. Its current Seller SKU and GTIN fields are also blank.

The actual back-label photograph shows barcode `8852629000204`, matching
POS 004 IC-001444, one base bag, with food registration
`74-1-21431-1-0013`. This independently links the unique Seller option to POS.

Reuse of this missing-SKU approval requires the typed unique-option proof,
Seller and description source hashes/rows, native IDs, packaging photograph
hash, matching packaging/POS barcode and matching POS evidence hash. A
missing proof or newly supplied conflicting SKU/native ID holds the line.
The original exact order-fingerprint path retains precedence.

## Read-only replay

| Scope | Result |
|---|---|
| 13–17 Nov | 2,146 orders, 2,774 source lines, all 55 remaining product lines resolved |
| Previously accepted current allocations | All 2,719 retain SKU, unit, pack factor, quantity, source amount and business date |
| Proposed current output | 300 copy rows; ฿605,930.00, equal to range BI |
| Current acceptance gate | Held: three daily reconciliation alerts, no product alerts; copy columns remain unavailable |
| 5–12 Nov regression | 3,724 orders, all 4,902 source allocations unchanged; ready, 357 copy rows, ฿1,252,380.00 |

The frozen production cohort and separately verified 55-line expected
SKU/unit/factor outcomes were used for the replay. Matching success does not
bypass the independent daily financial acceptance gate.

| Day | Candidate amount | BI amount | Difference | Candidate / BI orders |
|---|---:|---:|---:|---:|
| 13 Nov | ฿110,900 | ฿111,932 | −฿1,032 | 366 / 367 |
| 14 Nov | ฿94,671 | ฿94,012 | +฿659 | 353 / 353 |
| 15 Nov | ฿168,807 | ฿168,434 | +฿373 | 550 / 549 |
| 16 Nov | ฿122,299 | ฿122,299 | ฿0 | 466 / 466 |
| 17 Nov | ฿109,253 | ฿109,253 | ฿0 | 411 / 411 |

The range total balances because the three daily differences cancel. It is
not proof of correct daily attribution. The frozen BI sources for 13–15 Nov
were observed on 17 Nov. Their order counts also differ on 13 and 15 Nov.

The read-only investigation found cross-midnight creation/payment candidates.
There are multiple orders at the relevant amounts, including two different
฿373 orders created on 14 Nov and paid on 15 Nov. Amount equality and a
midnight boundary cannot identify the correct BI date. There are no verified
business-date corrections or line-evidence records for this cohort.

**Still required:** exact daily confirmed-product reports for 13, 14 and
15 November with order identity and report-day evidence. Reconcile both sides
of a proposed date correction before recording it. No date correction, source
amount, lifecycle or stock record was written in this work.

## Sources and verification

The source workbooks were downloaded from the signed-in SC Seller Centre
through its visible export flow. They were read without modification.

| Source | SHA-256 |
|---|---|
| mass_update_basic_info_1763530749_20261118160401.xlsx | b878a809678fa3660f5a6d240ebdd2f75d7529248b52a7d7feee99e8f5f8a655 |
| mass_update_sales_info_1763530749_20261118160441.xlsx | 2d73f2b1ab3856414dfd647d9bfa633716056b808321e6b4d229b373d78cd592 |

Private evidence under `work/copy-evidence-reuse-20261118/private/` includes
the frozen API/database cohorts, deployment acceptance, Seller rows, SELECT-only
POS 004 captures, packaging photographs, exact owner responses, verified
line outcomes, replay outputs and daily-gap investigation. Raw orders and
customer data remain outside Git. The original export files are in the local
Downloads folder.

Tests cover complete and incomplete missing-SKU proof, contradictory SKU and
native IDs, pack factors 5/20/3, the GEN-DM bag, the owner-resolved Erbatop box,
and the 39 existing promoted approvals. Existing gap/overlap, unit/pack conflict,
shop isolation, revoked approval and price-preservation tests also run.

The local accounting-copy suites passed 249 tests (two skipped). The broad
local run lacks a test PostgreSQL instance and its backend startup integration
suite fails for that environment requirement. CI supplies a separate disposable
PostgreSQL database; its result must be checked on the exact follow-up head.

The patch changes only accounting-copy registry evidence, the reviewed product
resolver, its tests and this documentation. It preserves all allocation policies
and does not change stock, baseline/cutover, lifecycle, sync, source financial
facts, source dates or AdaSmart documents.
