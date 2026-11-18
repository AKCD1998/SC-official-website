# Reuse SC product approvals for new orders

The live 13–17 November 2026 copy plan had 289 alerts. There were 284 product
lines and five daily reconciliation alerts. The product lines comprised 100
expired variation periods, 161 unsupported product-family matches and 23
incomplete attribute or pack matches.

Of those 284 product lines, 229 use the exact title, selected option and Order
All SKU of 39 previously reviewed source contracts. The previous contract
resolver recognizes an order's immutable meaning across rolling exports. A
different order number still requires another review, and the seven earlier
variation periods end on 5 November. This explains the repeated holds.

## Product approval

The existing 39 contracts gain an explicit verified `productReuse` declaration.
Each declaration retains its original source review and POS evidence. Its
effective start is the earliest independently reviewed order creation date for
that contract in the frozen 5–12 November cohort. It remains effective until an
explicit end or superseding version is recorded. The original order-specific
fingerprint path keeps precedence.

A new order must agree on shop, exact normalized title and option, Order All
identity, company SKU, ERP base unit and pack factor. The approval digest binds
the contract's source identity, dates, components and review evidence. Existing
explicit holds and contradictory accounting rules block reuse. Unknown native
IDs or barcodes require evidence. The 39 approvals have SKU-only Order All
identity, so newly supplied IDs cannot be silently accepted.

New orders may have different purchased quantities or prices. The unchanged
copy planner continues using each order's own source financial components,
approved allocations and exact-satang averaging. The product resolver supplies
only the verified SKU, unit and factor.

Pack versions use Bangkok creation dates. Gaps and overlapping versions block
reuse. Orders predating the first approval continue through the historical
resolver. An SKU correction, multi-SKU bundle or unapproved title/option needs
its own evidence. The 19 archived workbook-row exceptions and other existing
approvals keep their existing scope.

## Frozen production-data replay

| Scope | Live baseline | Candidate |
|---|---:|---:|
| 13–17 Nov orders / source lines | 2,146 / 2,774 | 2,146 / 2,774 |
| Product lines requiring review | 284 | 55 |
| Previously held lines resolved | — | 229 |
| Remaining distinct product/options | 60 | 21 |
| Eligible amount | ฿523,724.00 | ฿579,084.00 |
| Source-backed Business Insights | ฿605,930.00 | ฿605,930.00 |
| Outstanding amount | ฿82,206.00 | ฿26,846.00 |
| Copy status | Review required | Review required |

All 2,490 previously supported allocations in this scope preserve SKU, ERP unit,
pack factor, quantity, original financial attribution and business date.

The 5–12 November regression cohort remains ready for all eight days at
฿1,252,380.00. Its 3,724 orders and all 4,902 source-line allocations retain the
same SKU, unit, factor, quantity and amount. No historical line becomes held.

| Business date | Candidate eligible amount | Business Insights |
|---|---:|---:|
| 13 Nov | ฿110,674.00 | ฿111,932.00 |
| 14 Nov | ฿93,771.00 | ฿94,012.00 |
| 15 Nov | ฿157,890.00 | ฿168,434.00 |
| 16 Nov | ฿115,329.00 | ฿122,299.00 |
| 17 Nov | ฿101,420.00 | ฿109,253.00 |

These are read-only replay results. The production acceptance gate remains
closed for this scope until the outstanding product evidence is resolved.

The private frozen captures and row-level replay are stored under
`work/copy-evidence-reuse-20261118/private/` in the investigation workspace.
They retain the API baseline, original source hashes/rows, cohort and BI
evidence, copy identity proofs, and candidate results. Raw orders remain outside
Git.

## Outstanding product evidence

The 55 remaining lines represent 21 options. Their source SKU is a candidate
identifier. They still need the corresponding Seller option/pack and POS unit
evidence before receiving a reusable approval. GEN-DM also lacks an Order All
SKU. Erbatop has a possible size/formula conflict that needs an exact check.

| Product / selected option | Lines | Order All SKU |
|---|---:|---|
| Kangaroo 300 mL / จิงโจ้ 1 กระป๋อง | 17 | 630020333 |
| GEN-DM MF vanilla 2.5 kg / 1 ถุง | 7 | Missing |
| Klean&Kare / K&K 100มล. ฝาแหลม | 5 | 630020298 |
| Saugella 100 mL / เดอร์โมลิควิด มั่นใจ | 3 | IC-000301 |
| Tiger Balm HR white / 30 กรัม | 3 | 630010093 |
| CYBELE Scagel Kids / Kids 9 กรัม | 2 | 630010024 |
| Digital thermometer / Beurer FT09/1 | 2 | IC-001997 |
| Saugella 100 mL / แอ็ทติว่า ปกป้อง | 2 | IC-000300 |
| Sinocare CGM / iCan i6 CGM | 2 | IC-005860 |
| Mi-Herb / มีเฮิร์บสำลี 7กรัม | 1 | IC-005829 |
| ENO / AMOGIN EFFE / เอฟเฟส้ม 5ซอง | 1 | IC-005328 |
| Saugella 100 mL / โพลิจิน คาโมมายล์ | 1 | IC-000299 |
| Tiger Balm HR white / 10 กรัม | 1 | 630010095 |
| Erbatop / แถบชมพู มอยส์ 9% | 1 | IC-005480 |
| Kleanglove N / ไม่มีแป้ง ดำ,L | 1 | IC-002958 |
| Kleanglove N / ไม่มีแป้ง ดำ,XL | 1 | IC-004185 |
| Klean Mask Longmed / ดำ | 1 | IC-002951 |
| Saugella 100 mL / เกิร์ล อ่อละมุน | 1 | IC-005287 |
| Mybacin Zinc / น้ำผึ้งมะนาว 20 ซอง | 1 | IC-004647 |
| Plaivana / ครีม 35 กรัม | 1 | IC-001829 |
| Kangaroo 300 mL / จิงโจ้ 3 กระป๋อง | 1 | 630020333 |

The regular browser session had expired during this investigation. The live API
and database supplied the frozen baseline. The outstanding options have not
been reverified in a signed-in Seller Centre session in this change.

## Verification and boundaries

Regression tests cover new orders and changed prices, SKU conflicts, missing or
contradictory identifiers, changed approved factors/units/dates, revoked
approvals, explicit holds, contradictory pack rules, repack date boundaries,
gaps/overlaps, and shop isolation.

The patch changes accounting-copy evidence reuse and its tests. Production
source facts, Business Insights, stock reservations, opening balances,
lifecycle, sync and AdaSmart documents are outside this patch. Release review
must compare the deployed endpoint and its copy gate with the frozen results.
