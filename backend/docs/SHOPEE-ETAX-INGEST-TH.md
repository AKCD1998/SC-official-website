# Shopee e-Tax ingest

Backend รองรับ `reportType=etax-receipt-invoice` สำหรับหลักฐานใบเสร็จรับเงินและใบกำกับภาษีอิเล็กทรอนิกส์เต็มรูปแบบรายวัน

ข้อบังคับ:

- `dateFrom` ต้องเท่ากับ `dateTo`
- portal account ต้องตรงกับร้านที่ประกาศ
- ชื่อ ZIP ต้องเป็นชื่อสุ่มต้นฉบับที่ Shopee ส่งให้ ไม่อนุญาตชื่อที่สร้างใหม่
- SHA-256 และ multipart filename ต้องตรงกับ manifest
- ตรวจ ZIP/PDF และวันที่ในชื่อ PDF ซ้ำที่ backend
- ingest เป็น transaction และ replay ด้วย Job ID/หลักฐานเดิมต้อง idempotent

เพื่อจำกัดข้อมูลส่วนบุคคล Backend ไม่จัดเก็บ raw ZIP/PDF และไม่แตกข้อมูลผู้ซื้อเข้าฐานข้อมูล ตาราง official document source เก็บเฉพาะร้าน วันที่ ชื่อไฟล์ SHA-256 เวลานำเข้า จำนวนเอกสาร ขนาดรวม และ issuer control เท่านั้น ไฟล์ต้นฉบับคงอยู่บน 000-HQ ตาม retention ของ agent

หน้า document sync status แสดงแถว `Shopee e-Tax — ใบเสร็จรับเงิน/ใบกำกับภาษีอิเล็กทรอนิกส์เต็มรูป` สำหรับทั้งสองร้าน วันที่มีไฟล์ที่ผ่าน ingest เป็นสีเขียว ส่วนวันที่ Shopee ไม่มีเอกสารเป็น `unavailable` ไม่ถือเป็นความล้มเหลว

