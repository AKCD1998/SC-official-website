# SC Drug Store copy variation Phase 1

The existing copy endpoint keeps its resolver. Phase 1 runs through a read-only replay on this branch.

## Evidence follow-up for 45 source lines

The 21 SKU conflicts and 24 previously unresolved lines are verified for the exact reviewed Order All rows. Each new registry entry binds the SHA-256 and row number, exact product/option and expected Shopee SKU. Native IDs must agree when present. These entries run in shadow only. The regular exact-name resolver continues to use the same records it used before the follow-up.

For I-Herb 8-count, November Order All, the three Seller snapshots and POS agree on the standard sachet. Seller Centre links the [standard 8-lozenge sachet image](https://down-th.img.susercontent.com/th-11134207-81ztk-mrbfi63jlgxwf4) to option `441302625673`. The former explicit zip-sachet approval `IC-004806` / `8858923910096` stays in the historical exact rule. The audited November rows use `IC-003652` / `8858923900264`.

For MEGA Lecithin the Seller SKU fields are reversed. The 30/100 capsule option labels, the single-bottle description, and POS base barcodes independently agree on the mappings below. The exception applies to the audited rows with the observed swapped SKU. Another source SKU, a conflicting option ID, or different workbook lineage cannot borrow the correction.

| Reviewed option | Lines | Order All SKU | Verified POS SKU | Base units per sale | Seller GTIN |
|---|---:|---|---|---|---|
| I-Herb 8 lozenges | 7 | IC-003652 | IC-003652 | 1 sachet | 8858923900264 |
| MEGA Lecithin 100 capsules | 3 | IC-003712 | IC-000105 | 1 bottle | 8850769001662 |
| MEGA Lecithin 30 capsules | 11 | IC-000105 | IC-003712 | 1 bottle | 8850769002010 |
| Poy-Sian 3 mL flat glass dozen | 3 | 630010159 | 630010159 | 12 bottles | 8851447430101 |
| Poy-Sian Mark II case | 4 | 630010137 | 630010137 | 60 tubes | 8851447010020 |
| Tiger inhaler | 1 | IC-003000 | IC-003000 | 1 tube | 8888650438013 |
| Mybacin blackcurrant | 1 | IC-004321 | IC-004321 | 20 sachets | 8852294032050 |
| Mybacin grape-lime | 1 | IC-004322 | IC-004322 | 20 sachets | 8852294033057 |
| Mybacin strawberry | 1 | IC-005366 | IC-005366 | 20 sachets | 8852294034023 |
| Mybacin lychee | 1 | IC-005715 | IC-005715 | 20 sachets | 8852294037024 |
| Peppermint Field orange | 1 | IC-006128 | IC-006128 | 1 tube | 8850109273117 |
| Peppermint Field original | 1 | 630010138 | 630010138 | 1 tube | 8850109073311 |
| Bepanthen ointment 100 g | 1 | IC-004429 | IC-004429 | 1 tube | 4057599007718 |
| Five Horse blue 30 tablets | 2 | 630010067 | 630010067 | 24 pieces (tubes) | 8856570150032 |
| Vapex inhaler | 1 | 630010134 | 630010134 | 1 tube | 8850172241419 |
| Bella Para | 1 | IC-004545 | IC-004545 | 1 blister | 8859564200805 |
| Poy-Sian 8 mL cotton dozen | 1 | 630010157 | 630010157 | 12 bottles | 8851447430026 |
| Cemol 500 mg case | 3 | 630010104 | 630010104 | 50 blisters | 8852978010343 |
| Vita-C strawberry, 25 sachets | 1 | IC-002485 | IC-002485 | 25 sachets | 8857121535858 |

The Vita-C seller GTIN is for one 30-tablet sachet. The selected variation and POS pack level both confirm the 25-sachet factor. The POS 004 unit and barcode captures have SHA-256 `5eca5d3c2529c99cbeefbe586c5cfb12e86e54e71e2c4ac05c5dd3c24fef1e22` and `fdda0e49b3b6f51cc87948b59a20699302054230c95a407f21e5cd9b4384a7a4`.

| Replay after evidence follow-up | Audited lines accepted | Holds | Business Insights | Eligible subtotal | Shadow copy |
|---|---:|---:|---:|---:|---|
| 1–4 Nov 2026 | 17 | 0 | ฿420,071.00 | ฿420,071.00 | Ready, all 4 days match |
| 5 Nov 2026 | 28 | 0 | ฿104,563.00 | ฿104,563.00 | Ready |

The historical replay changes five I-Herb SKU allocations and preserves the other 1,887 previously passing allocations. The verified MEGA pack maps to the same POS SKU as the legacy plan. The 5 November run accepts four previously held SKU rows and all 24 missing rows alongside 19 earlier pilot matches and 474 legacy lines. No unit or factor divergence was observed for the independently verified lines.

## Evidence and hold behavior

- The SC Order All reader retains recognized SKU Reference No., Product/Item ID and Variation/Model ID columns in copy-only item metadata. Text keeps leading zeros. Imprecise numeric identifiers and contradictory columns are flagged without rejecting the financial report. Same-hash replays preserve immutable items.
- The seven pilot options link the old verified exact rule to Seller Centre exports and POS 004 evidence. The verified period uses the order creation date in Bangkok. The initial 1–4 November evidence is now corroborated through 5 November for these seven options by the 6 November Seller Sales and Basic exports and a fresh read of POS 004.
- The workbook needs the verified SKU, a certified Seller label for the applicable period, and agreement with any native IDs. Known exact pack counts and Seller option collisions are checked across the accounting registry, including entries outside the pilot. An unverified label with native IDs still needs pack evidence.
- The combined replay keeps hard holds for conflicting identifiers, packs, ambiguous evidence, and unsupported periods of enrolled options. Only out-of-scope decisions may use the existing rule. A proven old exact identity with agreeing source evidence may still use its historical rule before the pilot period.
- The Klean&Kare regression presents a verified 10-bottle carton label with the same SKU and the IDs of a single bottle. The combined plan holds it and withholds copy columns even though the money would otherwise balance. A second test does the same for a conflicting Order All SKU. Air-X synthetic tests keep 1 and 50 blisters distinct and use order creation time at a verified period boundary.

## Replays before the evidence follow-up

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

The workbook list includes one original XLSX member per hash in the captured cohort. The baseline can be ready or already require review. For a prospective run, `verifiedLines` contains one record per proposed match or hard hold, keyed by `orderNumber`, `sourceRow` and `sourceSha256`. It records `evidenceRef`, `outcome` and the expected `sku`, `unit`, `factor` for a match or `reasonCode` for a hold. An expected fallback may also be included. A missing verification, incorrect identity, incomplete source coverage or absent daily BI target makes the replay fail. For the historical pre-121 benchmark add `before` and include `verifiedLines` for the new audited row decisions. `expectedCounts` is optional for either mode.

Original workbooks and row-level captures stay outside Git. The replay emits aggregate results and review groups without writing to a database or AdaSmart.
