# New Shopee copy mappings — 30 September 2026

Twelve source identities on SC Drug Store's 29 September sales were either absent from the copy registry or used an unverified package conversion. The source financial amounts and the Business Insights order cohort already agreed. Exact shop/title/variant rules now resolve these identities to ERP base units.

The master evidence is StockDay branch 004, synced at `2026-09-30T08:21:03+07:00`, 6,766 unique SKUs. The preserved export is `stockday-004-20260930.xlsx`, SHA-256 `e5fb358d36946bda528db9c6c99836ba43800bf137ed768528bdde47c2454afe`. Only identity, barcode and unit metadata is checked into the registry. The workbook, customer/order details, balances and financial audit remain private.

| Source product / selected variant | ERP SKU | ERP units per listing sale | ERP unit |
|---|---|---:|---|
| Ensure Gold AdvancePro cereal, 380 g can | IC-000988 | 1 | กระป๋อง |
| BACTIGRAS 10×10 cm / 3 boxes | IC-000295 | 30 | แผ่น |
| SOS Plus transparent waterproof T / 9×15 cm | IC-001203 | 1 | กล่อง |
| SOS Plus transparent waterproof T4 / 10×25 cm | IC-000521 | 1 | กล่อง |
| Durex Protect 52.5 mm / 3 boxes | IC-002111 | 3 | ชิ้น |
| I-HERB OTC cough syrup / 60 mL | IC-004261 | 1 | ขวด |
| Swisse / Sunneday purple | IC-005339 | 1 | กระปุก |
| Tan Jai eucalyptus 5 g twin-head inhaler / blue | IC-006114 | 1 | ชิ้น |
| Durex / Kingtex 1 box | IC-000066 | 1 | ชิ้น |
| I-Herb combined listing / herbal lozenges 8 count, zip sachet | IC-004806 | 1 | ซอง |
| Vita-C 25 mg / grape, 1 bottle of 1000 tablets | IC-002911 | 1 | ขวด |
| Yoki in the circle / 100 g | IC-005707 | 1 | ขวด |

BACTIGRAS's three-box variant contains 30 ERP sheets. Durex's ERP `ชิ้น` describes a retail box of three condoms, so four listing bundles of three Protect boxes produce 12 ERP units. Neither conversion replaces the source merchandise value with an ERP price.

[SOS T specifications](https://www.bangkokwellbeing.co.th/products-sosplus-พลาสเตอร์ปิดแผลกันน้ำ-tseries) bridge T2×4 to the overall 9×15 cm size, with two sheets in a retail box. T4 is 10×25 cm, also two sheets per box. Both ERP masters use boxes. The T mapping excludes S/SB gauze even when dimensions are similar.

The user explicitly confirmed that the new I-Herb 8-count option is the **zip sachet IC-004806, barcode 8858923910096**. The older standard sachet IC-003652 / 8858923900264 remains separate. Stock availability is not used to select an identity or remove historical sales.

The mappings live in `shopeeAdaSmartCopyRules.v1.json` under evidence ID `stockday-004-20260930`, with exact identity boundaries, packaging rationale and source rows. They apply to future occurrences of the same identities without a date restriction. New names, formulas, variants or packages still require evidence rather than a guessed match.

Validation uses package/count tests with indivisible source cents, formula and shop boundaries, future sales dates, BI mismatch blocking, and separate I-Herb packaging. A read-only audit of the two shops' imported paid orders from 20 July through 30 September found these twelve identity gaps and no others. Rebuilding the frozen source data produces 120 ready day/shop plans, preserves the columns and totals of all 119 previously ready plans, and removes all identity review entries. Financial allocation policies and original source evidence are unchanged.
