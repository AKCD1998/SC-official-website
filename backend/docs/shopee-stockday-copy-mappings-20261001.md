# Shopee variant copy mappings — 1 October 2026

SC Drug Store's imported 30 September sales had 35 identity review entries because newly named listings and variants were absent from the AdaSmart copy registry. The source merchandise amounts and Business Insights cohort already agreed. Across the two shops' imported paid orders from 20 July through 1 October, these entries reduce to 21 unique shop/title/variant identities on 37 source lines. Exact rules now resolve all 21.

The existing StockDay evidence remains `stockday-004-20260930`: branch 004, sheet `Stock 004`, synced at `2026-09-30T08:21:03+07:00`, 6,766 unique SKUs. The preserved workbook SHA-256 is `e5fb358d36946bda528db9c6c99836ba43800bf137ed768528bdde47c2454afe`. Verification of the new mappings is dated 1 October; this does not claim a new stock export. Only SKU identity, barcode, ERP unit and packaging rationale are stored in the registry.

| Source product / selected variant | ERP SKU | ERP units per listing sale | ERP unit |
|---|---|---:|---|
| SOS blue S-series / S 8×8 cm | IC-004134 | 1 | กล่อง |
| SOS blue S-series / S2 6×7 cm | 630010162 | 1 | กล่อง |
| SOS blue S-series / M 4×7 cm | IC-004135 | 1 | กล่อง |
| SOS blue S-series / S3 6×10 cm | 630010161 | 1 | กล่อง |
| SOS red T-series / T2 6×7 cm | 630010166 | 1 | กล่อง |
| SOS red T-series / T1-B 3×7 cm | IC-002739 | 1 | กล่อง |
| SOS red T-series / T1 2.5×5.6 cm | 630010167 | 1 | กล่อง |
| SOS red T-series / mini S 2.2×3.5 cm | IC-003439 | 1 | กล่อง |
| SOS red T-series / M 4×7 cm | IC-004095 | 1 | กล่อง |
| SOS red T-series / T 8×8 cm | IC-004132 | 1 | กล่อง |
| I-HERB OTC syrup / 100 mL | IC-005465 | 1 | ขวด |
| Paracetamol strip listing / Bakamol 500 mg | IC-002039 | 1 | แผง |
| I-Herb combined listing / OTC lozenges 18 count | IC-005056 | 1 | ซอง |
| Yoki in the circle / 60 g | IC-000818 | 1 | กระป๋อง |
| Propoliz combined spray listing / Krachai 15 mL | IC-002067 | 1 | กล่อง |
| Propoliz combined spray listing / original Mouth Spray 15 mL | IC-001292 | 1 | กล่อง |
| Propoliz combined spray listing / Kid 10 mL | IC-002893 | 1 | ขวด |
| Propoliz combined spray listing / Kid 15 mL | IC-002706 | 1 | กล่อง |
| Tan Jai 5 g twin-head inhaler / orange | IC-006114 | 1 | ชิ้น |
| New One Gerd mint title / 1 box of 12×10 mL sachets | IC-002441 | 12 | ซอง |
| Deeday combined formula listing / Fiber Fiber | IC-005371 | 10 | ซอง |

The blue S-series gauze and red T-series waterproof dressings remain distinct even at identical dimensions. [S-series specifications](https://www.bangkokwellbeing.co.th/products-sosplus-ผ้าก๊อสปิดแผลพร้อมใช้-s-series) connect the S2×2 pad model to the overall 8×8 cm size and distinguish the S2, S3 and M models. [T-series specifications](https://www.bangkokwellbeing.co.th/products-sosplus-พลาสเตอร์ปิดแผลกันน้ำ-tseries) connect the T2×2 pad model to the overall 8×8 cm size. Historical public T-series descriptions and the current ERP master differ on that box's piece count; the rule uses the exact ERP model/barcode and sells one ERP box, without converting it into individual pieces or assuming the historical piece count. The T1 retail box of 10 remains separate from the master for a box of 100. The mini red S option is a T1 S waterproof dressing, not blue S-series gauze or skin-colour SB.

The user explicitly confirmed on 1 October that the combined Deeday listing's **Fiber Fiber option is one box of 10 sachets**. Its ERP master IC-005371 / barcode 8859612272143 uses sachets, so each sold box contributes ten ERP units. One Gerd's source title and selected variant explicitly state twelve sachets per box. Neither conversion changes the source merchandise amount or substitutes an ERP price.

The Propoliz formulas, Kids volumes, I-Herb lozenge packagings, syrup volumes, Bakamol strip/bottle packages and Yoki brands remain separate. The previously confirmed I-Herb 8-count zip sachet IC-004806 is unchanged. Rules are scoped by exact shop, product title and selected variant and continue to apply on future sale dates; unrecognised identities remain reviewable.

Validation covers all 21 conversions, source-cent conservation, same-size S/T separation, formula/package boundaries, numeric company-code copy text, future dates and BI mismatch blocking. Rebuilding a frozen read-only source snapshot makes all 122 imported day/shop plans ready, with no unresolved identities. The columns, quantities, prices, source amounts and totals of all 121 previously ready plans are identical to the before snapshot. Customer/order details, financial audit files and the master workbook remain private; no financial allocation policies or source records are modified.
