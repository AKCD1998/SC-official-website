# SC Drug Store copy variation Phase 1

The existing copy endpoint keeps its resolver. Phase 1 runs through a read-only replay on this branch.

## Evidence and hold behavior

- The SC Order All reader retains recognized SKU Reference No., Product/Item ID and Variation/Model ID columns in copy-only item metadata. Text keeps leading zeros. Imprecise numeric identifiers and contradictory columns are flagged without rejecting the financial report. Same-hash replays preserve immutable items.
- The seven pilot options link the old verified exact rule to Seller Centre exports and POS 004 evidence. The verified period uses the order creation date in Bangkok. The initial 1–4 November evidence is now corroborated through 5 November for these seven options by the 6 November Seller Sales and Basic exports and a fresh read of POS 004.
- The workbook needs the verified SKU, a certified Seller label for the applicable period, and agreement with any native IDs. Known exact pack counts and Seller option collisions are checked across the accounting registry, including entries outside the pilot. An unverified label with native IDs still needs pack evidence.
- The combined replay keeps hard holds for conflicting identifiers, packs, ambiguous evidence, and unsupported periods of enrolled options. Only out-of-scope decisions may use the existing rule. A proven old exact identity with agreeing source evidence may still use its historical rule before the pilot period.
- The Klean&Kare regression presents a verified 10-bottle carton label with the same SKU and the IDs of a single bottle. The combined plan holds it and withholds copy columns even though the money would otherwise balance. A second test does the same for a conflicting Order All SKU. Air-X synthetic tests keep 1 and 50 blisters distinct and use order creation time at a verified period boundary.

## Replays from actual files

| Metric | Historical 1–4 Nov 2026 | New 5 Nov 2026 |
|---|---:|---:|
| Orders | 1,406 | 345 |
| Source lines compared | 2,100 | 521 |
| Correct pilot matches among the reviewed exceptions or new cohort | 69 of the original 208 | 19 |
| PR #121 fallback among the original 208 or new cohort | 139 | 474 |
| Earlier accepted lines now held for a source SKU conflict | 17 | 4 |
| Existing unresolved lines outside the pilot | 0 | 24 |
| Incorrect SKU, POS unit or pack factor among the verified matches | 0 | 0 |
| Combined eligible subtotal | ฿417,579.00 | ฿93,235.00 |
| Business Insights target | ฿420,071.00 | ฿104,563.00 |
| Copy status | Review required | Review required |

Historical replay preserves 1,875 of the 1,892 previously passing allocations. The other 17 are deliberate holds that were visible once the replay retained the workbook SKU. I-Herb 8 lozenges accounts for five lines, MEGA Lecithin 100 capsules for three and MEGA Lecithin 30 capsules for nine. Both the historical and new runs withhold the copy columns.

| Bangkok business date | Combined eligible subtotal | Business Insights |
|---|---:|---:|
| 1 Nov | ฿111,447.00 | ฿112,383.00 |
| 2 Nov | ฿92,143.00 | ฿92,680.00 |
| 3 Nov | ฿107,368.00 | ฿107,825.00 |
| 4 Nov | ฿106,621.00 | ฿107,183.00 |
| 5 Nov | ฿93,235.00 | ฿104,563.00 |

The 5 November workbook has zero native variation IDs in the selected cohort. All seven options were reconfirmed by identical SKU, GTIN, selected label and pack description in the 5 and 6 November Seller exports. The 19 order lines each match a unique Seller option and a verified POS base unit. A separate expected-results file binds those lines and the four SKU conflicts to the original workbook hash and row. The new holds are two I-Herb 8-lozenge lines with workbook SKU `IC-003652` against reviewed `IC-004806` and two MEGA Lecithin 30-capsule lines with `IC-000105` against `IC-003712`. Both conflicting pairs resolve to distinct active POS items. The 24 open lines already appear in the live baseline.

### Source fingerprints

| Source | SHA-256 |
|---|---|
| Order All 1–4 Nov member | `098bd4c27ae6628754fa51d7d02d03710a3a034972f71e72bf7684167bef42c3` |
| Order All 5 Nov member | `aa3d792bddd42d951e5092661bdbbf03d67c6f91d989449e91d06547084ffabe` |
| 6 Nov Seller Sales | `20c1df048b498cef4fee8a71cce1a18bf859b621d72357e2c8c2dc60367b3574` |
| 6 Nov Seller Basic | `c2f041c0e8ad38389e20528f5c8b24253130745f4f57ca6d453d871a234b7759` |
| POS 004 reconfirmation | `59e6975af802b1d00a81430ae014d7ff6b8b92b19a399e1e0351a659c7d62cd6` |

## Reproduction with a new SC cohort

Run from the backend package with a private manifest. Paths resolve relative to the manifest.

```sh
node scripts/replay-shopee-copy-variation-phase1.cjs /private/replay-manifest.json
```

```json
{
  "capture": "copy-cohort-with-confirmed-bi.json",
  "proofRecords": "canonical-copy-proofs.json",
  "baseline": "captured-live-copy-plan.json",
  "sources": ["original-order-all-part-1.xlsx", "original-order-all-part-2.xlsx"],
  "verifiedLines": "independently-verified-lines.json"
}
```

The workbook list includes one original XLSX member per hash in the captured cohort. The baseline can be ready or already require review. For a prospective run, `verifiedLines` contains one record per proposed match or hard hold, keyed by `orderNumber`, `sourceRow` and `sourceSha256`. It records `evidenceRef`, `outcome` and the expected `sku`, `unit`, `factor` for a match or `reasonCode` for a hold. An expected fallback may also be included. A missing verification, incorrect identity, incomplete source coverage or absent daily BI target makes the replay fail. Use `before` in place of `verifiedLines` for the historical pre-121 plan. `expectedCounts` is optional for either mode.

Original workbooks and row-level captures stay outside Git. The replay emits aggregate results and review groups without writing to a database or AdaSmart.
