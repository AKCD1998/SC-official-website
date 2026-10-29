# Shopee → company SKU / POS 004 — 29 October 2026

Rule/evidence version: **sc004-seller-pos-20261029-r1**. Shop: SC Drug Store. Prepared from the existing canonical runtime, not the handoff's offline candidate labels.

## Baseline and current production status

At 2026-10-29T04:50:43.831Z, production had 21 mapping-review orders (morning handoff: 18), with 77 current and 77 original item lines. The full runtime used 30 dynamic rules and 91 trusted evidence facts in addition to the old static matcher and legacy evidence guard. Of the 77 current lines, 54 already mapped; 23 blocked lines represent 15 exact product/variation choices. The 19 static candidates in the handoff were never imported as approvals.

The existing authenticated human-admin contracts have now recorded 7 append-only POS metadata entries, 45 evidence facts and 15 version-1 identity rules. There were 17 serial POSTs; one evidence response timed out and was reconciled by its exact immutable references before continuing, without a repeat POST. Each rule outcome was independently reconciled by its stable operation ID and exact request. No SQL DML, source replay, queue reset, direct worker invocation, merge or deployment was used.

Latest read: 2026-10-29T05:29:36.443Z. Active rules: 45; evidence: 136; POS contracts: 265. Mapping-review positions remaining: **21**. Dirty orders: 410; pending identity recovery jobs: 5. Recovery is still running. A recorded rule is not evidence that its order exception or product fence has disappeared.

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
| gummy-pink-24-sachets.jpg | c5efe04547e29ce415885c1b24f448cafc1dbd426a0b9fe12f2b398348021639 |

The pink Gummy Plus variation image is th-11134207-81ztj-muhmxezoslj781, visibly labelled one box / 24 sachets. It was read from the live listing and saved privately as evidence. The generic Vita-C tablet description only mentions the 30-tablet sachet. Its 1000-tablet jar conversion is supported by the independently selected strawberry/jar variation and its exact SKU/POS package, not that generic paragraph.

At 2026-10-29T05:12:04.552Z, a second technically read-only POS audit retrieved all 47 component/master codes used by every one of the 77 current and 77 original lines. All were present and their active state, smallest unit and factors agreed with the stored contract. There were zero unit/stock-code conflicts. No current line in this particular queue is a multi-SKU bundle; separate regression suites exercise bundles and supported shared-stock masters.

Private local evidence includes the original XLSX files, full descriptions, POS metadata, all-line audit, before/after snapshots, immutable requests, outcomes and rollback operation IDs. These are not committed as a new runtime registry. The committed JSON fixture is test input only and is never imported by application code.

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
