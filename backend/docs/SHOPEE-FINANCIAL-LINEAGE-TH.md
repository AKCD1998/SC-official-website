# การสืบย้อนยอดการเงิน Shopee

เอกสารนี้กำหนดความหมายของตัวเลขและเกณฑ์ผ่านสำหรับหน้า **สรุปยอดขายสินค้า Shopee** ระบบต้องอธิบายการเปลี่ยนจากยอดหนึ่งไปสู่อีกยอดหนึ่งได้จากหลักฐานต้นทาง ห้ามเติมหรือกระจายส่วนต่างเพื่อทำให้ยอดดูตรงกัน

## จุดประสงค์ทางบัญชี

ยอดควบคุมสำหรับสร้าง Sales batch เข้า AdaSmart คือ **Business Insights — ยอดขาย (คำสั่งซื้อที่ได้รับการยืนยัน)** คำสั่งซื้อที่ได้รับการยืนยันแล้วแต่ยกเลิกภายหลังยังต้องอยู่ใน Sales batch เดิม เพราะฝ่ายบัญชีจะจัดทำรายการลดหนี้แยกในขั้นตอนถัดไป

ลำดับการสืบย้อนคือ:

1. Business Insights — ยอดขาย (คำสั่งซื้อที่ได้รับการยืนยัน)
2. Sales batch รายคำสั่งซื้อสำหรับ AdaSmart
3. หักยอดขายที่ยกเลิก โดยอ้างเลขคำสั่งซื้อเดิม (เหตุการณ์ยกเลิก)
4. หักยอดขายที่คืนเงิน/คืนสินค้า (เหตุการณ์คืนสินค้า ไม่ใช่เหตุการณ์ยกเลิก)
5. ยอดขายยืนยันแล้วสุทธิ
6. รายละเอียดรายรับของฉัน แสดงค่าธรรมเนียม ส่วนลด รายการปรับยอด และยอดรับของแต่ละคำสั่งซื้อ
7. Seller Balance และรายงานการเงินแสดงการรวมยอดตามรอบโอน

ขั้นที่ 6–7 **ไม่จำเป็นต้องเท่ากับยอดขาย** แต่ต้องมีองค์ประกอบและหลักฐานอธิบายความต่าง รายการ Income แบบรอดำเนินการและโอนสำเร็จแสดงแยกกัน และมุมมองสถานะล่าสุดเลือกหนึ่งสถานะต่อวงจรชีวิตของคำสั่งซื้อ จึงห้ามนำสองสถานะมาบวกกัน

## ฐานวันที่

| ชื่อใน Shopee | เขตเวลา | หน้าที่ |
|---|---|---|
| วันที่ทำการสั่งซื้อ | Asia/Bangkok | วันที่สร้างคำสั่งซื้อและช่วงของไฟล์ Order All |
| เวลาการชำระสินค้า | Asia/Bangkok | จัดวันของ Sales batch เพื่อกระทบ Business Insights |
| วันที่ยกเลิก/คืนสินค้า | Asia/Bangkok | เหตุการณ์สำหรับรายการลดหนี้ เก็บแยกจากวันที่ขายเดิม |
| เวลาที่ทำการสั่งซื้อสำเร็จ | Asia/Bangkok | หลักฐานสถานะสำเร็จ ไม่ใช้แทนเวลาชำระสินค้า |
| รอบรายงานการเงิน/เวลาโอน | Asia/Bangkok | จัด Income, Seller Balance และยอดโอน |

ช่วงวันที่ทุก API เป็นแบบรวมวันเริ่มและวันสิ้นสุดในหน้าจอ แต่ query ใช้ขอบเขต `[00:00 วันเริ่ม, 00:00 วันถัดจากวันสิ้นสุด)` ใน Asia/Bangkok เพื่อไม่ให้ข้อมูลตรงเที่ยงคืนซ้ำกัน

## สูตรและการเลือก snapshot

ยอดรายคำสั่งซื้อจาก Order All:

```text
ราคาขายสุทธิ
- โค้ดส่วนลดชำระโดยผู้ขาย
+ ส่วนลดจาก Shopee
```

หาก snapshot หลังยกเลิกทำให้ช่อง `โค้ดส่วนลดชำระโดยผู้ขาย` กลายเป็นศูนย์ ระบบกู้คืนค่าคอลัมน์นี้ได้เฉพาะระดับคำสั่งซื้อเมื่อครบทุกข้อ: (1) Order All bytes เดิมมี voucher code ตรงกัน (2) มีหลักฐาน Seller Centre ของ campaign นั้น (3) `เวลาการชำระสินค้า` อยู่ในช่วงใช้ voucher (4) ยอดถึงขั้นต่ำและเงื่อนไขสินค้าพิสูจน์ได้ และ (5) ผลคำนวณเป็นจำนวนสตางค์แน่นอน ค่านี้นำไปหักจากยอดขายตั้งต้นและยอดขายที่ยกเลิก ไม่ใช่เงินคืนให้ลูกค้า ระบบห้ามคืนส่วนลดจาก voucher code เพียงอย่างเดียว และห้ามใช้ยอดส่วนต่างรวมเป็นตัวปรับ

หลักฐานที่ยืนยันสำหรับ SC Drug Store คือ voucher `SVC-1489610191827020` ชื่อ `VCMT BAU 24-30 Aug` จากหน้า `https://seller.shopee.co.th/portal/marketing/vouchers/view?edit=1489610191827020` ช่วง 24 ส.ค. 2026 00:00 ถึง 30 ส.ค. 2026 23:59 (Asia/Bangkok), ส่วนลด 5%, สูงสุด 10.00 บาท, ขั้นต่ำ 110.00 บาท และใช้กับสินค้าทั้งหมด ระบบเก็บ URL ต้นทาง วันที่สังเกตพร้อม precision และ notes แยกจากหลักฐาน voucher code ใน Order All

- รายการที่ `เวลาการชำระสินค้า` เป็น `-` หรือว่าง ไม่เข้า Sales batch
- เลือก snapshot ทางการที่เก่าที่สุดซึ่งยังมีเวลาชำระสินค้าและองค์ประกอบการเงินครบเป็นหลักฐานยอดขายเดิม
- snapshot ล่าสุดกำหนดสถานะปัจจุบันและว่าต้องจัดทำรายการลดหนี้หรือไม่
- ทุกแถวอ้าง `shop_code + order_number` พร้อมชื่อไฟล์ SHA-256 เวลาตรวจพบไฟล์ และแถวต้นทาง; การคืน seller voucher อ้างทั้งหลักฐาน code ระดับออเดอร์และ campaign evidence
- อีเมลใช้เป็นหลักฐานเหตุการณ์หรือข้อมูลสำรองที่ระบุฐานชัดเจน ห้ามเขียนทับประวัติจากไฟล์ทางการ
- ช่วง `start_date/end_date` ของ Order All เป็น **ช่วงวันที่สร้างคำสั่งซื้อ** ไม่ใช่หลักฐานว่าครบทุกคำสั่งซื้อที่ชำระในวันเดียวกัน การผ่านรายวันต้องมีทั้งไฟล์ช่วงวันที่สร้างที่เกี่ยวข้อง ยอด/จำนวน Business Insights ตรงกัน และไฟล์ carry-over ของคำสั่งซื้อที่สร้างก่อนช่วงแต่ชำระในช่วง หากไม่พบหลักฐานช่วงก่อนหน้าให้เป็น `incomplete`; ห้ามสมมติ lag คงที่
- Income เก็บคอลัมน์จำนวนเงินที่เกี่ยวข้องครบด้วย key ภายในที่คงที่ แยกคอลัมน์รายละเอียดเงินคืนซึ่งไม่บวกซ้ำ พร้อม `additiveTotal` และ `unexplainedResidual` ต่อแถว ค่า residual ต้องแสดงตามจริงและห้ามใช้เป็น plug

หาก snapshot แรกที่มีอยู่ถูกสร้างหลัง Shopee แก้ข้อมูลของคำสั่งซื้อที่ยกเลิกแล้ว ระบบต้องแสดงยอดส่วนต่างและเลขคำสั่งซื้อผู้ต้องสงสัย ห้ามสร้าง `plug`, ห้ามเฉลี่ยส่วนต่าง และห้ามแก้ยอดรายคำสั่งซื้อโดยไม่มีหลักฐาน

## สถานะการกระทบยอด

- `reconciled` — หลักฐานครบ จำนวนคำสั่งซื้อเท่ากัน และส่วนต่างเป็น 0.00
- `unresolved` — มีข้อมูลทั้งสองฝั่งแต่ยอดหรือจำนวนไม่ตรง หรือฐานจำนวนเงินคืนยังพิสูจน์ไม่ได้
- `incomplete` — ขาด Business Insights รายวัน, Order All ที่มี carry-over หรือเอกสารประกอบ

รายสัปดาห์และรายเดือนต้องรวมจากผลรายวันตามเวลาชำระสินค้า หากส่วนต่างรายวันหักล้างกันจนยอดรวมเป็นศูนย์ แต่มีวันใดไม่ตรง สถานะสัปดาห์/เดือนยังเป็น `unresolved`

## API สำหรับผู้ดูแลระบบ

```http
GET /api/app/shopee/orders/sales-reconciliation
    ?shopCode=all
    &startDate=2026-08-01
    &endDate=2026-08-31
```

ข้อมูลสรุปเดียวกันอยู่ในฟิลด์ `reconciliation` ของ API `orders/sales-summary` สำหรับผู้ดูแลระบบ แต่ไม่ฝัง order ledger ขนาดใหญ่: ฟิลด์นี้มี `orderLedgerCount` และ aggregates เท่านั้น รายละเอียดรายคำสั่งซื้ออ่านจาก endpoint เฉพาะด้านบน ผู้ใช้ทั่วไปจะไม่ได้รับข้อมูลการเงินชุดใหม่นี้จาก server

ผลลัพธ์ endpoint เฉพาะประกอบด้วย `shops`, `aggregates.daily`, `aggregates.weekly`, `aggregates.monthly`, `orders`, `sourceCoverage`, `unresolved` และ `payoutBridge` แต่ละ stage แยกยอดทางการ ยอดสร้างใหม่ ส่วนต่าง จำนวนคำสั่งซื้อ ฐานวันที่ และสถานะ `sourceCoverage.orderAllCreationCoveredDays` หมายถึงความครอบคลุมตามวันสร้างเท่านั้น ไม่ใช่ population coverage ตามวันชำระ

Financial Statement และ Seller Balance เป็น downstream controls แยกกัน ระบบหาเอกสารด้วยช่วง `start_date/end_date` ที่ตรงกับรอบของ Income ซึ่งเชื่อมกับคำสั่งซื้อที่เลือก แม้รอบโอนจะอยู่หลังช่วงวันที่ขาย (เช่น ชำระ 31 ส.ค. แต่โอนในรอบ 1–7 ก.ย.) เอกสารที่เพียงทับซ้อนช่วงวันที่ขายแต่ไม่ตรงรอบ Income แสดงเป็น `unlinkedSources` และไม่ถูกอ้างว่าเชื่อมยอดแล้ว

## ขั้นตอน rollout และ backfill

Migration `021_shopee_financial_lineage.sql` เพิ่ม `paid_at` และ `completed_at` แบบ nullable ส่วน `022_shopee_seller_voucher_evidence.sql` เพิ่ม `voucher_codes` แบบ nullableและตารางหลักฐาน campaign จึงต้องลง migration ทั้งสอง **ก่อน** backend ที่เริ่มอ้างคอลัมน์ใหม่ เพื่อไม่ให้ upload ซึ่งเข้าระหว่าง rollout ล้มเหลว หลัง deploy backend ให้ replay ไฟล์ Order All และ Income ต้นฉบับเพื่อเติม timestamp/voucher code/องค์ประกอบที่ยังขาด ระบบเติมได้เฉพาะค่า NULL หรือ key ใหม่จาก bytes ที่มี SHA-256 เดิม; key/value เดิมทุกค่าต้องตรง และจะปฏิเสธ conflict โดยไม่สร้าง source/fact ซ้ำ

ลำดับที่ปลอดภัย:

1. สำรองฐานข้อมูลและตรวจ migration ในฐานทดสอบ
2. รัน migration 021 และ 022 ภายใต้ backend รุ่นเดิม แล้วตรวจว่าคอลัมน์ nullable, ตาราง evidence และ index พร้อม
3. deploy backend รุ่นใหม่
4. replay Order All ต้นฉบับของทั้งสองร้าน รวมช่วงวันที่สร้างแบบ carry-over เพื่อเติม `paid_at`, `completed_at` และ `voucher_codes`; replay Income ต้นฉบับเพื่อ enrich components
5. ตรวจหน้า reconciliation รายวันก่อน แล้วค่อยตรวจรายสัปดาห์และรายเดือน
6. deploy frontend หลัง API พร้อม
7. ยังไม่ส่ง Sales batch ไป AdaSmart หาก status ไม่ใช่ `reconciled` หรือมี source coverage ไม่ครบ

### วิธี replay/backfill ที่ไม่ทำลาย idempotency

ส่งไฟล์เดิมผ่าน `POST /api/agent/shopee/sales-sources` โดยใช้ SHA-256, ชื่อไฟล์, ร้าน, report type, ช่วงวันที่ และ `observedAt` เดิมทุกค่า แต่กำหนด `jobId` ใหม่ที่ไม่เคยใช้ เช่น suffix `.lineage-v1`:

```powershell
$sourcePath = Resolve-Path '.\Order.all.YYYYMMDD_YYYYMMDD.xlsx'
$sourceSha = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
curl.exe -H "Authorization: Bearer $env:SHOPEE_SALES_INGEST_TOKEN" `
  -F "shopCode=sc-drug-store" -F "reportType=orders" `
  -F "dateFrom=YYYY-MM-DD" -F "dateTo=YYYY-MM-DD" `
  -F "originalFilename=Order.all.YYYYMMDD_YYYYMMDD.xlsx" `
  -F "observedAt=ORIGINAL_ISO_TIMESTAMP_WITH_TIMEZONE" -F "sha256=$sourceSha" `
  -F "jobId=ORIGINAL_JOB_ID.lineage-v1" -F "file=@$sourcePath" `
  https://HOST/api/agent/shopee/sales-sources
```

สำหรับ Income เปลี่ยน `reportType` เป็น `income-pending` หรือ `income-transferred` และใช้ manifest เดิมของไฟล์นั้น การส่ง `jobId` เดิมคืน `unchanged` แบบ zero-write เสมอ จึง **ไม่** ทำ backfill; job ID ใหม่เป็นการสั่งให้ repository ตรวจ bytes/SHA เดิมแล้วทำ null-fill/enrichment แบบจำกัดขอบเขต การส่ง job ID ใหม่นั้นซ้ำอีกครั้งจะเป็น zero-write เช่นกัน เก็บ HTTP response และ job ID เป็น audit evidence และหยุดทันทีเมื่อได้ `409 conflict` หรือ `422 rejected` ห้ามเปลี่ยน SHA/ชื่อ/ช่วง/observedAt เพื่อหลบ validation

## เกณฑ์ยอมรับเดือนสิงหาคม 2026

ไฟล์ Business Insights ที่ฝ่ายบัญชียืนยันเป็นยอดควบคุม:

| ร้าน | ยอดขาย (คำสั่งซื้อที่ได้รับการยืนยัน) | คำสั่งซื้อ |
|---|---:|---:|
| SC Drug Store | 154,026.00 | 613 |
| DR.Morepen | 17,891.00 | 36 |

ผลที่คาดจากไฟล์ Order All และ campaign evidence ปัจจุบัน:

- DR.Morepen: Sales batch และยอดหลังหักคำสั่งซื้อที่ยกเลิกต้องตรง
- SC Drug Store: ออเดอร์ยกเลิก 11 รายการมี code `SVC-1489610191827020` และราคาขายสุทธิอย่างน้อย 200.00 บาท จึงถึงเพดานส่วนลด 10.00 บาทต่อออเดอร์จาก campaign evidence โดยตรง การกู้คืนค่าคอลัมน์ระดับออเดอร์รวมตามวันเป็น 20.00 บาท (25 ส.ค.), 30.00 บาท (28 ส.ค.), 10.00 บาท (29 ส.ค.) และ 50.00 บาท (30 ส.ค.) หลัง replay exact source ยอด Sales batch ต้องเป็น 154,026.00, ยอดขายที่ยกเลิก 7,478.00 และยอดสุทธิ 146,548.00; รายวัน/สัปดาห์/เดือนต้องเป็น `reconciled`

ตัวเลขเหล่านี้เป็นเกณฑ์ทดสอบ/เอกสาร ไม่ได้ hard-code เป็นยอดปรับใน service การคำนวณจริงอ่าน voucher code ระดับออเดอร์และ campaign evidence ที่นำเข้าเสมอ หากขาดหลักฐานส่วนใดให้คง `unresolved`/`incomplete`
