# Shopee → company SKU / POS 004 — 29 October 2026

Rule/evidence version: **sc004-seller-pos-20261029-r1**. Shop: SC Drug Store. Prepared from the existing canonical runtime, not the handoff's offline candidate labels.

An afternoon r2 supplement at the end records the later four-order intake separately. Morning counts below are historical, timestamped results.

## Baseline and current production status

At 2026-10-29T04:50:43.831Z, production had 21 mapping-review orders (morning handoff: 18), with 77 current and 77 original item lines. The full runtime used 30 dynamic rules and 91 trusted evidence facts in addition to the old static matcher and legacy evidence guard. Of the 77 current lines, 54 already mapped; 23 blocked lines represent 15 exact product/variation choices. The 19 static candidates in the handoff were never imported as approvals.

The existing authenticated human-admin contracts have now recorded 7 append-only POS metadata entries, 45 evidence facts and 15 version-1 identity rules. There were 17 serial POSTs; one evidence response timed out and was reconciled by its exact immutable references before continuing, without a repeat POST. Each rule outcome was independently reconciled by its stable operation ID and exact request. No direct SQL DML, source replay, queue reset, direct worker invocation, merge or deployment was used.

Latest read: 2026-10-29T05:52:59.117Z. Active rules: 45; evidence: 136; POS contracts: 265. Mapping-review positions remaining: **0**. Dirty orders: 269; pending identity recovery jobs: 0. The original 21 target orders have completed worker processing and were independently verified against actual stock lines and the live projection. Related background rechecks are still running; this is not a claim that all product availability is fully confirmed.

## Exact verified mappings

Every entry below is verified from the fresh Seller Centre export/selected variation and the independent SERVER004/AdaAcc smallest-unit metadata. Price and title similarity were not approval evidence. All 15 new components have companySku = stockCode and active factors 1. There are no new bundle or shared-stock conversions in this batch.

| # | Listing / variation | Company SKU / stock code | POS units per one sale | Sales-export row / basic-description row | Production rule / revision |
| --- | --- | --- | --- | --- | --- |
| 1 | 44483159777 / 321303027446 | 630010040 | 1 ซอง | 577 / 320 | 36db0d9d-86bc-492c-89b4-e420f366442e / 1 |
| 2 | 50268515652 / 262985307607 | IC-004132 | 1 กล่อง | 343 / 198 | 75035380-858b-4fc5-b416-c3c093931283 / 1 |
| 3 | 51869529492 / 283032578162 | IC-006176 | 1 ขวด | 250 / 150 | 21a46f2f-1276-4a0c-8600-653aba8e0e72 / 1 |
| 4 | 52564345285 / 401532221529 | IC-005488 | 1 หลอด | 235 / 139 | 5205e224-5160-49ea-9102-ce1f291f5a21 / 1 |
| 5 | 57319902365 / 326662499414 | IC-006139 | 1 ขวด | 47 / 25 | 1b507dc4-2640-4dfa-bc47-12fb67c71791 / 1 |
| 6 | 55569965110 / 386666310289 | IC-000060 | 1 กล่อง | 132 / 73 | 82730bc6-d35f-48ab-ad47-4be7b849fff9 / 1 |
| 7 | 51315697309 / 366341634058 | IC-000023 | 50 แผง | 281 / 166 | 07b72354-f013-445a-bf02-dae61cc07dac / 1 |
| 8 | 53361659593 / 346619420907 | IC-005886 | 10 ซอง | 209 / 121 | 74325c8a-235d-4184-9b43-fe9164750b39 / 1 |
| 9 | 55662773608 / 259349169775 | IC-002913 | 1 ขวด | 120 / 72 | e07ce4a5-4518-4337-93d5-6d8939a8c34b / 1 |
| 10 | 55569965110 / 386666310292 | 630010163 | 1 กล่อง | 131 / 73 | b560fb16-72f8-43b3-8433-44ddcffc57fa / 1 |
| 11 | 44483159777 / 321303027448 | 630010038 | 1 ซอง | 579 / 320 | 8796349b-bfff-4f4b-9f75-d9a0346f5993 / 1 |
| 12 | 55569965110 / 386666310291 | IC-006137 | 1 กล่อง | 130 / 73 | 7bfb04d5-72d1-4e86-a0f9-3dbb1423abc3 / 1 |
| 13 | 57319902365 / 326662499413 | IC-006138 | 1 ขวด | 46 / 25 | b1275b2c-d7d6-4c41-ac61-ae57721c7e36 / 1 |
| 14 | 56562041161 / 436046531379 | IC-001510 | 24 ซอง | 80 / 45 | 4cdd42a4-ec09-4b0c-975f-ca0871c1e9d9 / 1 |
| 15 | 49463620257 / 282765149031 | IC-005598 | 10 ชิ้น | 391 / 212 | 21a7c230-a6a4-4f24-a753-b72df0899047 / 1 |

### 1. คลู ฟ้า 8 เม็ด

- Status: verified. Authority: evidence review delegated by the user's 29 October mapping-repair request; authenticated actor is retained privately in the existing operation audit.
- Original inbox name: 1 ซอง Strepsils HHR สเตร็ปซิล 6/8 เม็ดตามสูตร เลือกรสได้
- Original option: คลู ฟ้า 8 เม็ด
- Fresh Seller Centre name: 1 ซอง Strepsils HHR สเตร็ปซิล 6/8 เม็ดตามสูตร เลือกรสได้
- Fresh Seller Centre option: คลู ฟ้า 8 เม็ด
- Exact Seller SKU → company SKU / stock identity: 630010040 → 630010040 / 630010040.
- POS name: สามัญ ยาอมสเตร็ปซิลคูล เอช เอช อาร์ 8 เม็ด. Smallest unit: ซอง. Sale multiplier: 1.
- Evidence: Description: one selected Cool HHR sachet of 8 lozenges. POS: 8-lozenge sachet, not individual tablets.
- Stable listing: https://seller.shopee.co.th/portal/product/44483159777
- Rule/evidence version: sc004-seller-pos-20261029-r1; production rule revision 1.

### 2. T 2x2 นิ้ว 8x8 ซม.

- Status: verified. Authority: evidence review delegated by the user's 29 October mapping-repair request; authenticated actor is retained privately in the existing operation audit.
- Original inbox name: SOS Plus พลาสเตอร์ใสปิดแผลกันน้ำ รุ่น T และแผ่นฟิล์มใส เลือกรุ่นและขนาดได้ (กล่องสีแดง)
- Original option: T 2x2 นิ้ว 8x8 ซม.
- Fresh Seller Centre name: SOS Plus พลาสเตอร์ใสปิดแผลกันน้ำ รุ่น T และแผ่นฟิล์มใส เลือกรุ่นและขนาดได้ (กล่องสีแดง)
- Fresh Seller Centre option: T 2x2 นิ้ว 8x8 ซม.
- Exact Seller SKU → company SKU / stock identity: IC-004132 → IC-004132 / IC-004132.
- POS name: สามัญ พลาสเตอร์ใสปิดแผลกันน้ำ เอสโอเอส พลัส รุ่น ที ซีรีส์ T 2x2 3 ชิ้น. Smallest unit: กล่อง. Sale multiplier: 1.
- Evidence: Description: selected T 2x2 inch / 8x8 cm package contains 3 dressings. POS: complete 3-piece box.
- Stable listing: https://seller.shopee.co.th/portal/product/50268515652
- Rule/evidence version: sc004-seller-pos-20261029-r1; production rule revision 1.

### 3. 300 มล.

- Status: verified. Authority: evidence review delegated by the user's 29 October mapping-repair request; authenticated actor is retained privately in the existing operation audit.
- Original inbox name: ออพติฟรี เพียวมอยซ์ 90/300 มล. OPTI-FREE PureMoist น้ำยาคอนแทคเลนส์ 1 ขวด
- Original option: 300 มล.
- Fresh Seller Centre name: ออพติฟรี เพียวมอยซ์ 90/300 มล. OPTI-FREE PureMoist น้ำยาคอนแทคเลนส์ 1 ขวด
- Fresh Seller Centre option: 300 มล.
- Exact Seller SKU → company SKU / stock identity: IC-006176 → IC-006176 / IC-006176.
- POS name: สามัญ ออพติ ฟรี เพียวมอยซ์ 300 มล. Smallest unit: ขวด. Sale multiplier: 1.
- Evidence: Description: PureMoist 300 ml sold as one bottle. Exact variant Seller SKU is IC-006176; Replenish is a different listing/SKU.
- Stable listing: https://seller.shopee.co.th/portal/product/51869529492
- Rule/evidence version: sc004-seller-pos-20261029-r1; production rule revision 1.

### 4. เซนซิเดิร์ม 50 กรัม

- Status: verified. Authority: evidence review delegated by the user's 29 October mapping-repair request; authenticated actor is retained privately in the existing operation audit.
- Original inbox name: บีแพนเธน ออยเมนต์ 30/50/100 กรัม และเซนซิเดิร์ม ครีม 20/50 กรัม (Bepanthen)
- Original option: เซนซิเดิร์ม 50 กรัม
- Fresh Seller Centre name: บีแพนเธน ออยเมนต์ 30/50/100 กรัม และเซนซิเดิร์ม ครีม 20/50 กรัม (Bepanthen)
- Fresh Seller Centre option: เซนซิเดิร์ม 50 กรัม
- Exact Seller SKU → company SKU / stock identity: IC-005488 → IC-005488 / IC-005488.
- POS name: สามัญ บีแพนเธน เซนซิเดิร์ม ครีม 50 กรัม. Smallest unit: หลอด. Sale multiplier: 1.
- Evidence: Description explicitly includes Sensiderm 50 g, separate from Ointment and Sensiderm 20 g. POS: one 50 g tube.
- Stable listing: https://seller.shopee.co.th/portal/product/52564345285
- Rule/evidence version: sc004-seller-pos-20261029-r1; production rule revision 1.

### 5. ไทเกอร์พล๊าส,30 มล.

- Status: verified. Authority: evidence review delegated by the user's 29 October mapping-repair request; authenticated actor is retained privately in the existing operation audit.
- Original inbox name: ยาใส่แผลโพวิโดนไอโอดีน 10% ศิริบัญชา เพียวริดีน โพวาดีน ไทเกอร์พล๊าส ลีโอโพวิโดน 15/30 มล.
- Original option: ไทเกอร์พล๊าส,30 มล.
- Fresh Seller Centre name: ยาใส่แผลโพวิโดนไอโอดีน 10% ศิริบัญชา เพียวริดีน โพวาดีน ไทเกอร์พล๊าส ลีโอโพวิโดน 15/30 มล.
- Fresh Seller Centre option: ไทเกอร์พล๊าส,30 มล.
- Exact Seller SKU → company SKU / stock identity: IC-006139 → IC-006139 / IC-006139.
- POS name: สามัญ ไทเกอร์พล๊าส ลีโอโพวิโดน 30 มล. Smallest unit: ขวด. Sale multiplier: 1.
- Evidence: Description: Tigerplast LeoPovidone 30 ml sold as one bottle. Exact Seller SKU and POS size agree.
- Stable listing: https://seller.shopee.co.th/portal/product/57319902365
- Rule/evidence version: sc004-seller-pos-20261029-r1; production rule revision 1.

### 6. ไทเกอร์พล๊าส 1 กล่อง

- Status: verified. Authority: evidence review delegated by the user's 29 October mapping-repair request; authenticated actor is retained privately in the existing operation audit.
- Original inbox name: พลาสเตอร์ผ้าปิดแผล 100 ชิ้น ไทเกอร์พล๊าส เทนโซพล๊าส ไรโนพลาสท์ นีโอพลาสท์-เอส
- Original option: ไทเกอร์พล๊าส 1 กล่อง
- Fresh Seller Centre name: พลาสเตอร์ผ้าปิดแผล 100 ชิ้น ไทเกอร์พล๊าส เทนโซพล๊าส ไรโนพลาสท์ นีโอพลาสท์-เอส
- Fresh Seller Centre option: ไทเกอร์พล๊าส 1 กล่อง
- Exact Seller SKU → company SKU / stock identity: IC-000060 → IC-000060 / IC-000060.
- POS name: สามัญ พลาสเตอร์ ไทเกอร์พล๊าส ชนิดผ้า 100 ชิ้น. Smallest unit: กล่อง. Sale multiplier: 1.
- Evidence: Description: selected Tigerplast cloth dressing sold as one box of 100. POS base unit is the complete 100-piece box.
- Stable listing: https://seller.shopee.co.th/portal/product/55569965110
- Rule/evidence version: sc004-seller-pos-20261029-r1; production rule revision 1.

### 7. รสมะนาว 1 กล่อง,1 กล่อง 50 แผง

- Status: verified. Authority: evidence review delegated by the user's 29 October mapping-repair request; authenticated actor is retained privately in the existing operation audit.
- Original inbox name: Air-X แอร์เอ็กซ์ ยาแก้ท้องอืด ท้องเฟ้อ จุกเสียด 3 รส ส้ม มินต์ มะนาว 1 กล่อง 50 แผง
- Original option: รสมะนาว 1 กล่อง,1 กล่อง 50 แผง
- Fresh Seller Centre name: Air-X แอร์เอ็กซ์ ยาแก้ท้องอืด ท้องเฟ้อ จุกเสียด 3 รส ส้ม มินต์ มะนาว 1 กล่อง 50 แผง
- Fresh Seller Centre option: รสมะนาว 1 กล่อง,1 กล่อง 50 แผง
- Exact Seller SKU → company SKU / stock identity: IC-000023 → IC-000023 / IC-000023.
- POS name: สามัญ แอร์ เอ็กซ์ มะนาว 10 เม็ด. Smallest unit: แผง. Sale multiplier: 50.
- Evidence: Selected variant explicitly states one box / 50 blisters. Description: 10 tablets per blister. POS base unit is one lemon 10-tablet blister; medium factor 50 confirms the outer box.
- Stable listing: https://seller.shopee.co.th/portal/product/51315697309
- Rule/evidence version: sc004-seller-pos-20261029-r1; production rule revision 1.

### 8. เจลลี่องุ่น 10 ซอง

- Status: verified. Authority: evidence review delegated by the user's 29 October mapping-repair request; authenticated actor is retained privately in the existing operation audit.
- Original inbox name: Deeday ดีเดย์ ผลิตภัณฑ์เสริมอาหาร วิตามินน้ำ 120 มล. Omega-3 / Bio C / Jelly Veggies เจลลี่รสองุ่น 10 ซอง
- Original option: เจลลี่องุ่น 10 ซอง
- Fresh Seller Centre name: Deeday ดีเดย์ ผลิตภัณฑ์เสริมอาหาร วิตามินน้ำ 120 มล. Omega-3 / Bio C / Jelly Veggies เจลลี่รสองุ่น 10 ซอง
- Fresh Seller Centre option: เจลลี่องุ่น 10 ซอง
- Exact Seller SKU → company SKU / stock identity: IC-005886 → IC-005886 / IC-005886.
- POS name: สามัญ ดีเดย์ เจลลี่ เวจจี้ รส องุ่น 20 กรัม. Smallest unit: ซอง. Sale multiplier: 10.
- Evidence: Description: Jelly Veggies grape sold as one box of 10 sachets, distinct from the liquid formulas. POS base unit is one 20 g sachet; medium factor 10.
- Stable listing: https://seller.shopee.co.th/portal/product/53361659593
- Rule/evidence version: sc004-seller-pos-20261029-r1; production rule revision 1.

### 9. สตรอว์เบอร์รี่,1 กระปุก 1000 เม็ด

- Status: verified. Authority: evidence review delegated by the user's 29 October mapping-repair request; authenticated actor is retained privately in the existing operation audit.
- Original inbox name: Vita-C วิตามินซี 25 มก. วิตามินซีอัดเม็ด (30 เม็ด / 25 ซอง และ 1000 เม็ด 1 กระปุก) &#124; Vitamin C Tablet
- Original option: สตรอว์เบอร์รี่,1 กระปุก 1000 เม็ด
- Fresh Seller Centre name: Vita-C วิตามินซี 25 มก. วิตามินซีอัดเม็ด (30 เม็ด / 25 ซอง และ 1000 เม็ด 1 กระปุก) &#124; Vitamin C Tablet
- Fresh Seller Centre option: สตรอว์เบอร์รี่,1 กระปุก 1000 เม็ด
- Exact Seller SKU → company SKU / stock identity: IC-002913 → IC-002913 / IC-002913.
- POS name: สามัญ ไวต้าซี วิตามินซี สตอร์เบอรี่ 25 มก 1000  เม็ด. Smallest unit: ขวด. Sale multiplier: 1.
- Evidence: Live selected strawberry / one jar of 1000 tablets has Seller SKU IC-002913, distinct from the 25-sachet option IC-002485. POS names the complete strawberry 1000-tablet bottle. Generic description only describes the separate 30-tablet sachet and is not the jar quantity authority.
- Stable listing: https://seller.shopee.co.th/portal/product/55662773608
- Rule/evidence version: sc004-seller-pos-20261029-r1; production rule revision 1.

### 10. นีโอพลาสท์-เอส1กล่อง

- Status: verified. Authority: evidence review delegated by the user's 29 October mapping-repair request; authenticated actor is retained privately in the existing operation audit.
- Original inbox name: พลาสเตอร์ผ้าปิดแผล 100 ชิ้น ไทเกอร์พล๊าส เทนโซพล๊าส ไรโนพลาสท์ นีโอพลาสท์-เอส
- Original option: นีโอพลาสท์-เอส1กล่อง
- Fresh Seller Centre name: พลาสเตอร์ผ้าปิดแผล 100 ชิ้น ไทเกอร์พล๊าส เทนโซพล๊าส ไรโนพลาสท์ นีโอพลาสท์-เอส
- Fresh Seller Centre option: นีโอพลาสท์-เอส1กล่อง
- Exact Seller SKU → company SKU / stock identity: 630010163 → 630010163 / 630010163.
- POS name: สามัญ พลาสเตอร์ผ้านีโอพลาสท์ 100 แผ่น. Smallest unit: กล่อง. Sale multiplier: 1.
- Evidence: Description: selected Neoplast-S sold as one box of 100. POS base unit is the complete 100-piece box.
- Stable listing: https://seller.shopee.co.th/portal/product/55569965110
- Rule/evidence version: sc004-seller-pos-20261029-r1; production rule revision 1.

### 11. ออริจินอล แดง 8 เม็ด

- Status: verified. Authority: evidence review delegated by the user's 29 October mapping-repair request; authenticated actor is retained privately in the existing operation audit.
- Original inbox name: 1 ซอง Strepsils HHR สเตร็ปซิล 6/8 เม็ดตามสูตร เลือกรสได้
- Original option: ออริจินอล แดง 8 เม็ด
- Fresh Seller Centre name: 1 ซอง Strepsils HHR สเตร็ปซิล 6/8 เม็ดตามสูตร เลือกรสได้
- Fresh Seller Centre option: ออริจินอล แดง 8 เม็ด
- Exact Seller SKU → company SKU / stock identity: 630010038 → 630010038 / 630010038.
- POS name: สามัญ ยาอมสเตร็ปซิลออริจินัล เอช เอช อาร์ 8 เม็ด. Smallest unit: ซอง. Sale multiplier: 1.
- Evidence: Description: one selected Original HHR sachet of 8 lozenges. POS: 8-lozenge sachet, not individual tablets.
- Stable listing: https://seller.shopee.co.th/portal/product/44483159777
- Rule/evidence version: sc004-seller-pos-20261029-r1; production rule revision 1.

### 12. ไรโนพลาสท์ 1 กล่อง

- Status: verified. Authority: evidence review delegated by the user's 29 October mapping-repair request; authenticated actor is retained privately in the existing operation audit.
- Original inbox name: พลาสเตอร์ผ้าปิดแผล 100 ชิ้น ไทเกอร์พล๊าส เทนโซพล๊าส ไรโนพลาสท์ นีโอพลาสท์-เอส
- Original option: ไรโนพลาสท์ 1 กล่อง
- Fresh Seller Centre name: พลาสเตอร์ผ้าปิดแผล 100 ชิ้น ไทเกอร์พล๊าส เทนโซพล๊าส ไรโนพลาสท์ นีโอพลาสท์-เอส
- Fresh Seller Centre option: ไรโนพลาสท์ 1 กล่อง
- Exact Seller SKU → company SKU / stock identity: IC-006137 → IC-006137 / IC-006137.
- POS name: สามัญ ไรโนพลาสท์ พลาสเตอร์ผ้า 100 แผ่น. Smallest unit: กล่อง. Sale multiplier: 1.
- Evidence: Description: selected Rhinoplast sold as one box of 100. POS base unit is the complete 100-piece box.
- Stable listing: https://seller.shopee.co.th/portal/product/55569965110
- Rule/evidence version: sc004-seller-pos-20261029-r1; production rule revision 1.

### 13. ไทเกอร์พล๊าส,15 มล.

- Status: verified. Authority: evidence review delegated by the user's 29 October mapping-repair request; authenticated actor is retained privately in the existing operation audit.
- Original inbox name: ยาใส่แผลโพวิโดนไอโอดีน 10% ศิริบัญชา เพียวริดีน โพวาดีน ไทเกอร์พล๊าส ลีโอโพวิโดน 15/30 มล.
- Original option: ไทเกอร์พล๊าส,15 มล.
- Fresh Seller Centre name: ยาใส่แผลโพวิโดนไอโอดีน 10% ศิริบัญชา เพียวริดีน โพวาดีน ไทเกอร์พล๊าส ลีโอโพวิโดน 15/30 มล.
- Fresh Seller Centre option: ไทเกอร์พล๊าส,15 มล.
- Exact Seller SKU → company SKU / stock identity: IC-006138 → IC-006138 / IC-006138.
- POS name: สามัญ ไทเกอร์พล๊าส ลีโอโพวิโดน 15 มล. Smallest unit: ขวด. Sale multiplier: 1.
- Evidence: Description: Tigerplast LeoPovidone 15 ml sold as one bottle. Exact Seller SKU and POS size agree.
- Stable listing: https://seller.shopee.co.th/portal/product/57319902365
- Rule/evidence version: sc004-seller-pos-20261029-r1; production rule revision 1.

### 14. กัมมี่ ชมพู

- Status: verified. Authority: evidence review delegated by the user's 29 October mapping-repair request; authenticated actor is retained privately in the existing operation audit.
- Original inbox name: Vita-C ไวต้า-ซี วิตามินซี กัมมี่ / กัมมี่พลัส / ชิววี่ รสผลไม้รวม แบบยกกล่อง
- Original option: กัมมี่ ชมพู
- Fresh Seller Centre name: Vita-C ไวต้า-ซี วิตามินซี กัมมี่ / กัมมี่พลัส / ชิววี่ รสผลไม้รวม แบบยกกล่อง
- Fresh Seller Centre option: กัมมี่ ชมพู
- Exact Seller SKU → company SKU / stock identity: IC-001510 → IC-001510 / IC-001510.
- POS name: สามัญ ไวต้า ซี มัลติฟรุตกัมมี่พลัส ชมพู 20 กรัม. Smallest unit: ซอง. Sale multiplier: 24.
- Evidence: Live pink variation image th-11134207-81ztj-muhmxezoslj781 explicitly states 1 box / 24 sachets. Description identifies pink Gummy Plus, 20 g per sachet. POS: one pink 20 g sachet, medium factor 24. Do not substitute Chewy white 20 sachets or an unproven 12-sachet box.
- Stable listing: https://seller.shopee.co.th/portal/product/56562041161
- Rule/evidence version: sc004-seller-pos-20261029-r1; production rule revision 1.

### 15. แอปเปิ้ลเขียว 10ซอง

- Status: verified. Authority: evidence review delegated by the user's 29 October mapping-repair request; authenticated actor is retained privately in the existing operation audit.
- Original inbox name: ไวต้า-ซี / โพรโพลิซ แคนดี้ป๊อป อมยิ้มไม่มีน้ำตาล ยกกล่อง 10 ซอง Vita-C / Propoliz Candy Pop
- Original option: แอปเปิ้ลเขียว 10ซอง
- Fresh Seller Centre name: ไวต้า-ซี / โพรโพลิซ แคนดี้ป๊อป อมยิ้มไม่มีน้ำตาล ยกกล่อง 10 ซอง Vita-C / Propoliz Candy Pop
- Fresh Seller Centre option: แอปเปิ้ลเขียว 10ซอง
- Exact Seller SKU → company SKU / stock identity: IC-005598 → IC-005598 / IC-005598.
- POS name: สามัญ ไวต้าซี แคนดี้ป๊อป กลิ่นแอปเปิ้ลเขียว 7 กรัม. Smallest unit: ชิ้น. Sale multiplier: 10.
- Evidence: Description: selected green-apple Candy Pop is one box of 10 sachets, each 7 g. POS smallest unit is one 7 g piece (medium factor 10); not a whole 70 g box.
- Stable listing: https://seller.shopee.co.th/portal/product/49463620257
- Rule/evidence version: sc004-seller-pos-20261029-r1; production rule revision 1.

## Source receipts and limitations

Seller Centre all-status exports generated on 29 October contain 380 listing descriptions and 696 variation rows. The product screen showed 381 listings. This discrepancy does not establish that the missing listing was deleted. All 15 target choices occur uniquely in this export.

| Source file | SHA-256 |
| --- | --- |
| mass_update_sales_info_1763530749_20261029124220.xlsx | 2fdedecfc8388ba56ebcc6bc40f937c911f4c05f8bc82464681ce0d82b04fe26 |
| mass_update_basic_info_1763530749_20261029124233.xlsx | 798bef5f3f1bcf94a73772929d8038c8b3f391855261552a8f3529afd4b49ebe |
| candy-pop-green-apple-10-sachets.jpg | 2e76e652684359f3e646837a77253e5bfdfba48fcda99ffd5a6c2e72273ac425 |
| vita-c-jar-1000-versus-25-sachets.jpg | 84ddab3e09e5ee47d19161782d2d46c1395bb245d4f1e691b6e888e32c3362e7 |
| gummy-pink-24-sachets.jpg | c5efe04547e29ce415885c1b24f448cafc1dbd426a0b9fe12f2b398348021639 |

The pink Gummy Plus variation image is th-11134207-81ztj-muhmxezoslj781, visibly labelled one box / 24 sachets. It was read from the live listing and saved privately as evidence. Supplemental live images read during recovery independently show Candy Pop green apple as 10 sachets / 70 g per box / 7 g per sachet (th-11134207-81zto-muspnn40pmv408), and the red strawberry Vita-C jar as 1000 tablets, separate from its 30-tablet sachet / 25-sachet sale option (th-11134207-81zto-musqn4wcuvpg60). These later image receipts add corroboration; they did not create another evidence import or recovery job. The generic Vita-C tablet description only mentions the 30-tablet sachet. Its 1000-tablet jar conversion is supported by the independently selected strawberry/jar variation and its exact SKU/POS package, not that generic paragraph.

At 2026-10-29T05:12:04.552Z, a second technically read-only POS audit retrieved all 47 component/master codes used by every one of the 77 current and 77 original lines. All were present and their active state, smallest unit and factors agreed with the stored contract. There were zero unit/stock-code conflicts. No current line in this particular queue is a multi-SKU bundle; separate regression suites exercise bundles and supported shared-stock masters.

Private local evidence includes the original XLSX files, full descriptions, POS metadata, all-line audit, before/after snapshots, immutable requests, outcomes and rollback operation IDs. These are not committed as a new runtime registry. The committed JSON fixture is test input only and is never imported by application code.

## Actual production verification

At 2026-10-29T05:52:59.117Z all 21 original target positions were reserved, with no remaining product_mapping_unverified reason and no target left in the dirty queue. Independent arithmetic uses the unchanged original 54 mapped lines plus the 23 new lines and their separately verified SKU/factor evidence. Every target order and all 47 distinct stock identities agree with their actual stored quantities and POS units. The live projection returned HTTP 200 for all 47; global reserved/shipped figures and units agreed exactly with the captured actual stock lines plus the unchanged accepted opening basis. Zero quantity/unit differences were observed. The two reads have separate timestamps and revisions while unrelated background work runs; they are not claimed as an atomic snapshot.

The live exception endpoint was read through all four pages at 2026-10-29T05:54:34.697Z. None of the 21 original exception UUIDs appeared. The remaining 64 lifecycle reviews and related background rechecks were not approved or reset. A new unreviewed cancellation remains separately fenced with its old hold retained.

StockDay production was also inspected directly for both bottle and sachet units. The contemporaneous Hourly POS base minus the verified reservations and unchanged pre-existing unposted figures agrees with the displayed calculation. Both retain the temporary/known-commitments label while wider allocation remains incomplete. No older opening/unposted quantity was introduced by this repair. Screenshots and the per-SKU arithmetic remain private local evidence; they are not committed as stock balances.

## Proposed / conflicting / superseded

- Verified and recorded: the 15 choices above.
- Proposed approvals still requiring missing evidence in this 21-order batch: zero.
- Conflicting quantity or unit facts in this batch: zero.
- Superseded as an approval source: the handoff's 19 offline static candidates. Five candidates were already resolved by dynamic rules; the later live queue also contained a new Candy Pop choice. The original 30 dynamic rules were preserved byte-for-byte.
- Older whole-store Lecithin/I-Herb conflicts described in the 23 October audit are outside this current queue. They were not silently approved or relabelled verified.

## Simulation versus production acceptance

The simulation replays all 1,969 captured positions through the exact full runtime (versioned identity matcher, trusted evidence derivation, legacy guard and static matcher). Baseline mismatch count: zero. Evidence-only contract changes: zero. Adding the 15 rules changes exactly 21 mapping reviews into reserved positions, yielding all 77 current lines mapped. The existing 54 mapped lines are identical. All 64 original lifecycle-review positions, retained lines, opening plan and fixed cutover are unchanged in that frozen-input simulation. A new cancellation email arrived at 2026-10-29T05:25:10Z for an unrelated pre-existing reserved order while recovery was running. It is separately audited as an independent source change: its held quantities remain retained under cancel-dispatch-unverified and no lifecycle review was added. A natural new post-cutover order was also observed. These events do not replace the accepted baseline. Unknown quantities are never replaced by zero.

The stored POS contract grows from 258 to 265 entries. It does not modify physical POS stock, accepted opening orders, source status or lifecycle evidence. Recovery uses the existing immutable-rule operation journal and durable cursor queue. No broad historical debit or release is authorized by these mappings.

Backend checks: 353 passing tests in 15 suites, including isolated PostgreSQL, duplicate events/email effects, same-operation replay, restarts, revocation, pack/unit conflicts, exact old/new aliases, bundles and shared-stock guards. Frontend: 148 passing tests; production build passed. The test PostgreSQL instance binds only 127.0.0.1:55439 and contains synthetic data.

## Seamless display patch awaiting code review

Live producer c852ba85c0482671fa5b8ad06363e300be0d5d82 already uses the existing versioned identity registry for StockDay. Seamless frontend ade86d558d60fb177ad17bc92e80978ec81730a2 still displays its accounting productMatch. The production order screen was inspected and still showed “รอตรวจสอบ SKU” for an evidenced target; recording a stock rule does not update that separate display.

The prepared backend patch adds a bounded READ ONLY snapshot for at most 25 orders / 1,000 items, using the same identityStore and mapShopeeStockLines validator. It returns a separate stockProductMatch field. The frontend patch displays the verified SKU, factor and POS unit; blocked/unavailable stock evidence cannot fall back to a convenient accounting SKU or zero. Other shops and the existing OFF path avoid these reads. Accounting productMatch, prices, financial visibility, AdaSmart copy/export and lifecycle states are preserved.

These patches remain unmerged and undeployed pending acceptance. Apply backend before frontend; the old frontend ignores the additive field, and the new frontend tolerates an older backend. Exact company SKU searches also derive verified aliases from the same runtime matcher before all-page pagination. Revoked/blocked aliases and another shop or pack are excluded. An unavailable canonical SKU lookup returns a temporary error rather than a false empty success. Ordinary name/date/amount searches keep their existing behavior. No Hourly, Full Sync, Transfer Delta, flags, credentials, schedules, opening balance or permanent cutover change is included.

<!-- AFTERNOON_20261029 -->

## Afternoon supplement — sc004-seller-pos-20261029-r2

The morning repair is a dated result. A fresh read at 2026-10-29T07:56:39.954Z found four new mapping-review orders after the original 21 had completed recovery. These four orders contain six current lines: two already matched, four blocked. All six original snapshot lines were also checked. The 19 choices verified across r1 (15) and r2 (4) are **not** the handoff's 19 offline static candidates.

All four additions below are verified. Proposed choices awaiting missing evidence: zero. Conflicting SKU/unit choices within this supplement: zero. None requires a new bundle/shared-stock conversion. The existing database registry, canonical matcher, durable worker and operation journal remain the authority.

| Selected option | Listing / variation | Company SKU / stock code | POS units per sale | Seller export row | Production rule / revision |
| --- | --- | --- | --- | --- | --- |
| เซนซิเดิร์ม 20 กรัม | 52564345285 / 401532221528 | IC-000482 | 1 หลอด | 239 | f0d30913-62bc-4393-a5a4-51ce91c0ce39 / 1 |
| ส้ม 10ซอง | 49463620257 / 411176133511 | IC-005323 | 10 ชิ้น | 390 | 64f3e460-b529-4b99-ae7a-63c308a4fd22 / 1 |
| กัมมี่ เหลือง | 56562041161 / 436046531381 | IC-001849 | 24 ซอง | 82 | 36224a87-f260-481a-b0b2-67adc6f8ccc4 / 1 |
| สเปรย์ 800 มล. | 44035513071 / 436666739807 | IC-006025 | 1 ขวด | 589 | e43733a3-739e-44b5-9300-3679ae55a625 / 1 |

### เซนซิเดิร์ม 20 กรัม

- Status: verified. Rule/evidence version: sc004-seller-pos-20261029-r2; server rule revision 1.
- Original inbox name: บีแพนเธน ออยเมนต์ 30/50/100 กรัม และเซนซิเดิร์ม ครีม 20/50 กรัม (Bepanthen)
- Original inbox option: เซนซิเดิร์ม 20 กรัม
- Current saved Seller Centre name: บีแพนเธน ออยเมนต์ 30/50/100 กรัม และเซนซิเดิร์ม ครีม 20/50 กรัม (Bepanthen)
- Current saved Seller Centre option: เซนซิเดิร์ม 20 กรัม
- Exact Seller SKU → company SKU / stock code: IC-000482 → IC-000482 / IC-000482.
- POS name: สามัญ บีแพนเธนเซนซิเดร์ม 20 กรัม. Active, stockFactor = smallFactor = 1. Smallest unit: หลอด.
- Conversion per one sale: 1 หลอด.
- Evidence: Fresh saved Seller export selects Sensiderm 20 g, Seller SKU IC-000482. Description distinguishes Sensiderm 20/50 g from Ointment 30/50/100 g. Fresh POS independently names the 20 g tube, smallest unit one tube.
- Stable listing: https://seller.shopee.co.th/portal/product/52564345285

### ส้ม 10ซอง

- Status: verified. Rule/evidence version: sc004-seller-pos-20261029-r2; server rule revision 1.
- Original inbox name: ไวต้า-ซี / โพรโพลิซ แคนดี้ป๊อป อมยิ้มไม่มีน้ำตาล ยกกล่อง 10 ซอง Vita-C / Propoliz Candy Pop
- Original inbox option: ส้ม 10ซอง
- Current saved Seller Centre name: ไวต้า-ซี / โพรโพลิซ แคนดี้ป๊อป อมยิ้มไม่มีน้ำตาล ยกกล่อง 10 ซอง Vita-C / Propoliz Candy Pop
- Current saved Seller Centre option: ส้ม 10ซอง
- Exact Seller SKU → company SKU / stock code: IC-005323 → IC-005323 / IC-005323.
- POS name: สามัญ ไวต้าซี แคนดี้ป๊อป กลิ่นส้ม 7 กรัม. Active, stockFactor = smallFactor = 1. Smallest unit: ชิ้น.
- Conversion per one sale: 10 ชิ้น.
- Evidence: Exact orange Candy Pop variation/Seller SKU IC-005323. Saved Seller description specifies one box / 10 sachets / 7 g each. Previously captured live listing image independently shows the orange 70 g box / 10 sachets. Fresh POS is the orange 7 g piece, medium factor 10; do not borrow the green-apple SKU.
- Stable listing: https://seller.shopee.co.th/portal/product/49463620257

### กัมมี่ เหลือง

- Status: verified. Rule/evidence version: sc004-seller-pos-20261029-r2; server rule revision 1.
- Original inbox name: Vita-C ไวต้า-ซี วิตามินซี กัมมี่ / กัมมี่พลัส / ชิววี่ รสผลไม้รวม แบบยกกล่อง
- Original inbox option: กัมมี่ เหลือง
- Current saved Seller Centre name: Vita-C ไวต้า-ซี วิตามินซี กัมมี่ / กัมมี่พลัส / ชิววี่ รสผลไม้รวม แบบยกกล่อง
- Current saved Seller Centre option: กัมมี่ เหลือง
- Exact Seller SKU → company SKU / stock code: IC-001849 → IC-001849 / IC-001849.
- POS name: สามัญ ไวต้า ซี มัลติฟรุตกัมมี่ เหลือง 20 กรัม. Active, stockFactor = smallFactor = 1. Smallest unit: ซอง.
- Conversion per one sale: 24 ซอง.
- Evidence: Reuse an existing approved physical-stock contract, not an accounting-only inference: catalog shopee-company-sku-2026-09-03 row 34 has the identical listing 56562041161 / variation 436046531381 and explicit 24-sachet option. The current saved Seller export preserves that stable identity and Seller SKU IC-001849, names yellow 20 g Gummy and sells one whole box. Fresh POS is one yellow 20 g sachet with medium factor 24. The canonical physical matcher resolves the old exact name/24-sachet option as verified existing_verified_pack, using adasoft-base-unit-2026-09-03-v3. No pink/white pack factor or price is used.
- Stable listing: https://seller.shopee.co.th/portal/product/56562041161

### สเปรย์ 800 มล.

- Status: verified. Rule/evidence version: sc004-seller-pos-20261029-r2; server rule revision 1.
- Original inbox name: โซฟลอรา กลิ่นเมาน์เทน แอร์ สเปรย์ 800 มล. / สูตรเข้มข้น 500 มล. Zoflora Mountain Air
- Original inbox option: สเปรย์ 800 มล.
- Current saved Seller Centre name: โซฟลอรา กลิ่นเมาน์เทน แอร์ สเปรย์ 800 มล. / สูตรเข้มข้น 500 มล. Zoflora Mountain Air
- Current saved Seller Centre option: สเปรย์ 800 มล.
- Exact Seller SKU → company SKU / stock code: IC-006025 → IC-006025 / IC-006025.
- POS name: สามัญ โซฟลอรา กลิ่นเมาน์เทน แอร์ 800 มล. Active, stockFactor = smallFactor = 1. Smallest unit: ขวด.
- Conversion per one sale: 1 ขวด.
- Evidence: Exact Mountain Air ready-to-use spray 800 ml variation has Seller SKU IC-006025. Saved Seller description explicitly sells one bottle per selected formula, distinguishes 800 ml spray from 500 ml concentrate and says it is not a two-bottle set. Fresh POS names Mountain Air 800 ml, smallest unit bottle.
- Stable listing: https://seller.shopee.co.th/portal/product/44035513071

### Supplement source receipts and runtime boundary

All four exact listing/variation/Seller SKU identities occur uniquely in the same 29 October sales/basic-description exports whose SHA-256 receipts are recorded above. The raw files were preserved and read offline during an authorized Chrome backup hold; no browser launch, reconnect or profile change was made for this supplement. Fresh SERVER004/POS 004 metadata was read at 2026-10-29T07:58:03.7818908Z through the existing technically read-only SQL Server reader. Three contracts already existed unchanged; only Zoflora IC-006025 required an append-only contract. Actual inventory balances were not edited.

A second all-line POS read at 2026-10-29T08:20:25.807Z independently checked all six component codes used by the six current and six original lines, including the two previously matched lines. All six were returned with identical active state, stock code, smallest unit and factors; there were zero conflicts and no blocked lines in the evidenced full-runtime replay. The per-line current/original audit remains private. There are no multi-SKU or shared-stock conversions in these six lines.

For yellow Gummy, the old exact physical-stock matcher independently returns IC-001849 ×24 ซอง, quantityRuleStatus=verified, quantityEvidence=existing_verified_pack and matchSource=approved_catalog_and_erp_base_unit. The old title was “Vita-C วิตามินซี กัมมี่ 3 รสชาติ (ส้ม แอปเปิ้ล องุ่น) | Vitamin C Gummy เคี้ยวง่าย อร่อย ทานได้ทุกวัน”, option “24 ซอง”, source row 34, under the identical listing/variation and company SKU. The fresh export preserves the identity and exact yellow 20 g SKU; fresh POS independently confirms the 24-sachet medium unit. The quantity fact is honestly recorded as reviewed_stock_rule, referencing shopee-company-sku-2026-09-03-row-34 and adasoft-base-unit-2026-09-03-v3. The generic current description does not independently state the count. No accounting-only price inference or another colour's pack size is used.

| Prior physical-rule source | SHA-256 |
| --- | --- |
| shopeeProductCatalog.v1.json | 726b3fe1a1c24b39e56a3aa3b5aec5c63a774fdacd5acb22fabe690737e36670 |
| shopeeSkuUnitValidation.v1.json | 65d50abf153bb45b2472388af0c06f6a4736261544da2f9f6d4933648cd5c157 |

An external deployment changed producer c852ba85c0482671fa5b8ad06363e300be0d5d82 to 5a2d1d672d607f47741d9f68f2e0592054264201 before r2 activation. Its seven changed files concern member-code aliases and their docs/tests. A read-only Git diff verified the entire seamless module, worker paths and stock contracts were unchanged. The supervised controller stopped on the old runtime guard before any r2 write; the new exact commit was accepted only after this audit. This task did not merge or deploy that change.

The StockDay API also changed externally from 6ca6fdcd917496405fe370d3ba8c246ac21d1dc9 to 40ef239a43b7ba2104376aad296242b062ba28d1. Its three changed files concern branch 003 POS 002 device-inventory policy and its docs/test. The actual Shopee stock display, projection-recovery, branch-stock and exception-consumer paths are byte-identical across these versions. The final live versions are producer 5a2d1d6, StockDay API 40ef239, StockDay web e1f236d and Seamless ade86d5; none was deployed by this task.

### Supplement simulation, tests and recorded administration

The full 2,042-position frozen-input simulation has zero baseline replay mismatches and zero evidence-only changes. Adding exactly four rules changes exactly four mapping reviews to reserved, preserves the two already matched current lines, maps all six current lines and leaves all 70 independent lifecycle reviews unchanged. The opening plan, permanent cutover and all other stock contracts are unchanged in that simulation. This paragraph describes simulation, not a production recovery claim.

Existing protected administration recorded one append-only POS contract, 12 evidence facts and four version-1 rules through six serial POSTs. Every immutable operation outcome was read back and reconciled; no POST was repeated. Across both batches this task records 19 rules, 57 facts and eight POS additions, through 23 serial administration POSTs. There is no SQL DML, queue reset, worker invocation, lifecycle approval, source replay, credential/flag/schedule change or historical debit.

Latest backend validation: **357 tests pass in 15 suites**, including the four added exact-variation regressions and isolated PostgreSQL. The first r2 full run hit the default 5-second route-test timeout during application loading, causing a following shared-mock assertion to fail; rerunning the same complete suite with a 30-second timeout passed all 357 in 21.074 seconds, without changing application code to accommodate the failure. The local synthetic PostgreSQL instance was stopped afterward. Frontend code is unchanged from its 148-test/build validation. The test fixture remains regression input only; application code never imports it as a second registry.

### Supplement actual production acceptance

At 2026-10-29T08:29:01.325Z, all four new target positions were reserved with exactly the separately calculated SKU quantities/units. Both previously matched lines remain identical. All original 21 r1 contracts were independently rechecked and remain exact: **25 orders resolved in total**, 83 current lines (56 already mapped, 27 previously blocked). The source database and live projection were compared for 52 distinct SKU identities, with zero quantity/unit mismatches. The unchanged accepted opening basis is included in existing unposted totals; it is not a new historical deduction. Reads have separate timestamps and are not claimed as an atomic snapshot. Their ledger revisions agree: true.

The first final comparison deliberately failed closed when a new independent post-cutover order was processed between the database read (08:28:05.966Z) and projection read (08:28:14.731Z): global held stock for 630020296 increased by two bottles while all 25 mapping-target contracts remained exact. The failed comparison and both original reads were preserved. A fresh settled database/projection comparison at the acceptance times above then agreed for all 52 products. No zero replacement, direct reservation edit or retrying an administration POST was used to clear this read race.

The actual registry now has 49 active rules, 148 trusted facts and 266 POS contracts. At that read, global mapping reviews: 0; other lifecycle reviews: 70; dirty rechecks: 0; pending recovery jobs: 0. Related recovery/lifecycle uncertainty remains separate from the accepted mapping targets. Opening plan, permanent cutover and human lifecycle-review history are unchanged. Unknown stock evidence is never promoted to confirmed zero.

The complete live exception pagination was read at 2026-10-29T08:28:13.338Z (1 pages). None of the 25 original r1/r2 exception UUIDs appeared.

Afternoon endpoint/database acceptance is actual production evidence. Direct browser inspection remains held for the authorized Chrome backup. The earlier StockDay bottle/sachet screenshots verify r1 at their own timestamps, not the later r2 screen state. Seamless's display/search patch remains in Draft PRs #102/#48 and is not deployed; production can still show its older accounting-matcher label until those patches are accepted and released.
