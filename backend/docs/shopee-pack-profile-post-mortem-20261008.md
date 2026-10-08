# Shopee copy matching: incomplete option coverage, 2026-10-08

## What happened

Previously verified products reappeared in the AdaSmart copy review when sold under combined listings with different formulas, sizes or pack counts. The saved mappings were still present. The earlier structural matcher covered selected families and verified options, rather than every declared option in each listing. It lacked typed Polar, Myda and Yoki profiles, and Propoliz lozenges lacked the Extherb formula. The current blue SOS frame also lacked anchors for two declared sizes.

This is a coverage defect in the earlier implementation. Adding an exact mapping for a sale encountered today did not establish coverage of the other options already present in that listing. A balanced Business Insights total cannot establish product identity or packaging.

## Evidence and correction

Checked six current Seller Centre listings against the fresh StockDay all-branches master export, synchronized 2026-10-08T01:21:03.150Z, SHA-256 `d521dd9ca6748acdeb66a1f8d350d66e077f61b3da23b4c941c9fd16e8125853`. This adds 20 durable exact rules and four missing ERP master identities. Together with existing rules, all 32 declared options in those six listings now have verified SKU and base-unit quantities.

| Listing | Verified options | Identity and quantity basis |
| --- | ---: | --- |
| Polar bulk blue / Innocence white, 57468770472 | 8 | Cap formula + per-can volume + explicit can count; each can is one ERP unit |
| SOS blue S Series, 29695968791 | 8 | Series + selected model/dimensions; each sale is one ERP box |
| Myda sulfur 2.5% 30/80 g, 54164731217 | 4 | Bar size + explicit bar count; single-bar SKU in the same listing verifies the base identity |
| Propoliz single retail units, 57666141262 | 4 | Selected formula; Extherb/X use ERP blisters, Original/Vit C use sachets |
| Propoliz bulk boxes, 45666159990 | 4 | Selected formula + explicit 10 sachets or 15 blisters per box |
| Yoki circle / 1997 60/100 g, 42584807676 | 4 | Selected model + size; do not combine the circle and 1997 SKU families |

SOS outer dimensions 9x15 cm correspond to the manufacturer S2x4 model, three dressings per retail box. StockDay uses the model name while the listing uses outer dimensions. The current listing SKU and [manufacturer S Series specifications](https://www.bangkokwellbeing.co.th/products-sosplus-ผ้าก๊อสปิดแผลพร้อมใช้-s-series) establish the correspondence. ERP quantity remains one **box**, not three pieces.

## Matcher changes

- Add typed Polar, Myda and Yoki profiles. A newly expressed count of identical verified cans/bars/containers can scale the ERP base-unit quantity without another date-specific name rule. Formula/model and per-unit size must still agree.
- Add the explicit Extherb formula and blister packaging to Propoliz lozenges. Recognize the full Thai Extherb word before the shorter X token, and treat `Lozenge` as a category when an explicit formula is present.
- Add complete evidence for the declared options above so the known-frame allowlist includes all of them. Do not derive the selected option from another option in a combined listing.
- Increment algorithm version to `verified-structural-copy-2026-10-08-v3`; the existing digest invalidates matching caches when version or durable evidence changes.

New short titles must specify formula/model, size and packaging. Unknown formulas, conflicting sizes/counts, wrong units, missing selected options, and mixed-SKU gifts retain review. Exact-match precedence, existing quantity holds, source identifiers and shop boundaries remain in force.

## Validation ledger

- Positive cases include new pack counts absent from exact rules, numeric Yoki SKU retention, distinct blue/white Polar formulas, Myda 30/80 g separation, Extherb/X separation, and SOS box-versus-piece quantities.
- Negative cases include conflicting formula/model/size, unspecified selected options in combined frames, unsupported units, changed box contents, zero/excessive pack counts and mixed-SKU gifts.
- Synthetic sanitized import → catalog enrichment → copy-plan tests preserve original source money while expanding only the evidenced ERP quantities.
- Frozen regression: all 134 previously ready day/shop plans retain exact clipboard columns, original source membership/amounts, SKU quantities, BI totals and order counts. Ten September/October range checks retain the sum of their daily plans. Gift prices remain the already approved 0.10 per gift base unit.
- Full Linux CI, production API and browser clipboard checks are deployment gates; their immutable results are recorded in the private completion ledger.

Windows full-suite attempts also expose existing test-environment issues (no local test database and LF-specific workflow text assertions). These are not changes to the matching code; the configured Linux/PostgreSQL CI is the full-suite gate.

## Persistence and rollback

SKU/pack evidence is versioned in the repository and survives restart/deploy. Structural reuse applies within supported, unambiguous profiles; a genuinely new formula, SKU or ambiguous multi-product bundle still needs independent evidence. This change makes no source-order, financial-allocation, database-policy, BI, or AdaSmart-document writes. Rollback is a revert of this code/data commit. Raw catalog captures, financial snapshots, workbook details and order identifiers remain outside Git.
