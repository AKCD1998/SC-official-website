# SC Drug Store copy variation Phase 1

The production copy endpoint continues to use the existing resolver. The Phase 1 matcher runs through the offline replay below. There is no activation switch in this PR.

## Evidence and review

- The SC Order All reader retains recognized SKU Reference No., Product/Item ID and Variation/Model ID columns in copy-only item metadata. Text keeps its leading zeros. Imprecise numeric identifiers and conflicting headers are flagged without rejecting the financial report. Existing snapshots and same-hash replays retain immutable item data.
- The seven pilot entries extend the existing accounting registry. Each links the old verified exact rule to the Seller Centre export before and after the rename. The records capture the listing and variation IDs, SKU, GTIN, export hashes and row numbers, plus the approved POS unit and pack basis. Both export files were checked for exact alias uniqueness.
- An order must carry the same SKU and identify one eligible Seller variation. If its variation ID is absent, the exact name and option must link to a certified unique Seller entry. Source SKU hits are candidate hints. The verified period uses the order creation date in Bangkok. Overlapping periods, contradictory source fields and pack evidence gaps produce grouped review decisions.
- The pilot window is 1–4 November 2026. Coverage outside this window requires evidence for the applicable pack period. Established exact rules continue to handle other orders.

## Read-only replay against PR #121

The captured SC cohort contains 1,406 orders and 2,100 source product lines. The native Order All part had the SKU column and zero native variation IDs in the cohort. The 69 new matches therefore used the unique Seller evidence route. Native IDs and changing pack windows were exercised by tests.

| Result for the 208 pre-121 exceptions | Source lines |
|---|---:|
| Correct with the new rule alone | 69 across 7 options |
| Held without the PR #121 exact-name fallback | 139 across 46 review groups |
| Resolved by the existing PR #121 exact-name fallback | 139 |
| Wrong SKU, POS unit or multiplier | 0 |

The replay checks all 2,100 lines against the verified PR #121 allocations. It confirms that the 1,892 previously passing source lines retain their results, including 27 that the Phase 1 matcher independently matched. The combined run reproduces the exact copy columns, approved allocation policies, and source cents. The isolated run keeps the 139 held lines out of the ready subtotal and returns no copy columns.

| Bangkok business date | Phase 1 only plus previously passing | Combined | Business Insights |
|---|---:|---:|---:|
| 1 Nov | ฿109,595.00 | ฿112,383.00 | ฿112,383.00 |
| 2 Nov | ฿90,027.00 | ฿92,680.00 | ฿92,680.00 |
| 3 Nov | ฿102,432.00 | ฿107,825.00 | ฿107,825.00 |
| 4 Nov | ฿103,172.00 | ฿107,183.00 | ฿107,183.00 |
| Total | ฿405,226.00 | ฿420,071.00 | ฿420,071.00 |

## Before and after examples

| Seller option | Before the rename | Current Order All label | New match |
|---|---|---|---|
| Klean&Kare dumbbell 1000 mL | `1000 มล. ดัมเบล` under the Klean&Kare-only listing title | `K&K 1000มล. ดัมเบล` under the combined saline title | Variation `396391334428`, SKU `630020295`, ×1 bottle |
| Tylenol 500 | `ไทลินอล 500` under the older paracetamol listing title | Same option label under the expanded listing title | Variation `351510475163`, SKU `630010105`, ×1 blister |
| Air-X orange, synthetic test | One blister and a case share the same SKU | Each verified option has its own identity | SKU `630010147`, ×1 or ×50 blisters according to the option |

The changed-pack test uses the same variation with consecutive verified periods. A pre-cutover order keeps ×1 even if paid later. A new order in the second period uses ×50, and conflicting label or overlapping period evidence holds the line.

## Reproduction

Run from the backend package with the authorized local evidence from the November incident. The original workbook and private order captures are kept outside Git. The script checks the original XLSX against SHA-256 `098bd4c27ae6628754fa51d7d02d03710a3a034972f71e72bf7684167bef42c3` and emits aggregate results without writing to the database or AdaSmart.

```sh
node scripts/replay-shopee-copy-variation-phase1.cjs \
  /private/incident-20261105-context.json \
  /private/incident-20261105-copy-proof-records.json \
  /private/incident-20261105-sc-recent.json \
  /private/incident-20261105-copy-plan-candidate.json \
  /private/sources/Order.all.20261005_20261104_part_2_of_2.xlsx
```

The fourth input is the candidate whose full row array matched the live PR #121 result after deployment.
