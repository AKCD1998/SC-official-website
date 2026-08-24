const {
  extractShopeeBodyText,
  parseShopeeDateTime,
  parseShopeeOrderEmail,
} = require("../src/modules/seamless/services/shopeeOrderEmailParser");

function encode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function rawHtmlMessage({ id, subject, body, internalDate = "1787549837000" }) {
  return {
    id,
    internalDate,
    labelIds: ["INBOX"],
    payload: {
      headers: [
        { name: "From", value: "Shopee <info@mail.shopee.co.th>" },
        { name: "Subject", value: subject },
      ],
      mimeType: "multipart/alternative",
      parts: [{ body: { data: encode(body) }, mimeType: "text/html" }],
    },
    threadId: `thread-${id}`,
  };
}

const SENSITIVE_PRODUCT_LABEL_CASES = [
  "• ข้อมูลผู้ซื้อ: Private Buyer",
  "- ข้อมูลผู้รับ: Private Recipient",
  "▪ ที่อยู่สำหรับจัดส่ง: Private Address",
  "1) เบอร์โทรมือถือ: 0812345678",
  "(1) หมายเลขโทรศัพท์มือถือ: 0898765432",
];

test("extractShopeeBodyText reads nested HTML-only Gmail messages", () => {
  const raw = rawHtmlMessage({
    id: "gmail-html",
    subject: "แจ้งเตือน",
    body: "<html><style>.hidden{display:none}</style><div>รายละเอียด&nbsp;คำสั่งซื้อ</div><div>จำนวน: 2</div></html>",
  });

  expect(extractShopeeBodyText(raw)).toBe("รายละเอียด คำสั่งซื้อ\nจำนวน: 2");
});

test("parses a real-template COD confirmation into non-empty bounded items", () => {
  const raw = rawHtmlMessage({
    id: "gmail-confirmed",
    subject: "คำสั่งซื้อชำระเงินปลายทาง #26082476830R2P จากผู้ซื้อ private_buyer ถูกยืนยันแล้ว",
    body: `
      <div>เรียน Seller</div>
      <div>หมายเลขคำสั่งซื้อ:</div><div>#26082476830R2P</div>
      <div>วันที่สั่งซื้อ:</div><div>24/08/2026 16:13:40</div>
      <div>รายละเอียดคำสั่งซื้อ</div>
      <div>1.</div><div>สินค้าทดสอบ A</div>
      <div>ตัวเลือกสินค้า:</div><div>9 กรัม</div>
      <div>จำนวน:</div><div>2</div>
      <div>ราคา:</div><div>฿84</div>
      <div>ยอดรวมค่าสินค้า:</div><div>฿168</div>
      <div>ค่าจัดส่งสินค้า:</div><div>฿38</div>
      <div>ยอดที่ต้องชำระทั้งหมด:</div><div>฿197</div>
      <div>กรุณานัดรับกับ Standard Delivery - ส่งธรรมดาในประเทศ ผ่านทางแอป</div>
      <div>ผู้ซื้อ private_buyer ยืนยันภายหลัง</div>
    `,
  });

  const parsed = parseShopeeOrderEmail(raw, "admin@scgroup1989.com");

  expect(parsed.event).toMatchObject({
    eventType: "order_confirmed",
    gmailMessageId: "gmail-confirmed",
    orderNumber: "26082476830R2P",
  });
  expect(parsed.order).toMatchObject({
    deliveryMethod: "Standard Delivery - ส่งธรรมดาในประเทศ",
    itemCount: 1,
    itemSubtotal: 168,
    orderedAt: "2026-08-24T09:13:40.000Z",
    shippingFee: 38,
    totalAmount: 197,
    totalQuantity: 2,
  });
  expect(parsed.order.items[0]).toEqual({
    name: "สินค้าทดสอบ A",
    quantity: 2,
    unitPrice: 84,
    variant: "9 กรัม",
  });
  expect(JSON.stringify(parsed)).not.toContain("private_buyer");
  expect(JSON.stringify(parsed)).not.toContain("เรียน Seller");
});

test.each(SENSITIVE_PRODUCT_LABEL_CASES)(
  "fails the whole product section closed for prefixed sensitive label: %s",
  (sensitiveLabel) => {
    const raw = rawHtmlMessage({
      id: `gmail-sensitive-${SENSITIVE_PRODUCT_LABEL_CASES.indexOf(sensitiveLabel)}`,
      subject: "คำสั่งซื้อชำระเงินปลายทาง #26082476830R2P จากผู้ซื้อ private_buyer ถูกยืนยันแล้ว",
      body: `
        <div>หมายเลขคำสั่งซื้อ: #26082476830R2P</div>
        <div>รายละเอียดคำสั่งซื้อ</div>
        <div>1. สินค้าปลอดภัย</div>
        <div>จำนวน: 1</div>
        <div>ราคา: ฿84</div>
        <div>${sensitiveLabel}</div>
        <div>ยอดรวมค่าสินค้า: ฿84</div>
      `,
    });

    const parsed = parseShopeeOrderEmail(raw, "admin@scgroup1989.com");
    expect(parsed.order.items).toEqual([]);
    expect(parsed.order.itemCount).toBe(0);
    expect(JSON.stringify(parsed)).not.toMatch(/private buyer|private recipient|private address|0812345678|0898765432/iu);
  },
);

test.each([
  [
    "numbered item",
    "<div>สินค้าที่ไม่มีเลขลำดับ</div><div>จำนวน: 1</div><div>ราคา: ฿84</div><div>ยอดรวมค่าสินค้า: ฿84</div>",
  ],
  [
    "quantity",
    "<div>1. สินค้าทดสอบ</div><div>ราคา: ฿84</div><div>ยอดรวมค่าสินค้า: ฿84</div>",
  ],
  [
    "price",
    "<div>1. สินค้าทดสอบ</div><div>จำนวน: 1</div><div>ยอดรวมค่าสินค้า: ฿84</div>",
  ],
  [
    "totals boundary",
    "<div>1. สินค้าทดสอบ</div><div>จำนวน: 1</div><div>ราคา: ฿84</div>",
  ],
])("requires %s inside the verified real-template product section", (requirement, productHtml) => {
  const raw = rawHtmlMessage({
    id: `gmail-missing-${requirement.replace(/\s/gu, "-")}`,
    subject: "ถึงเวลาจัดส่งสินค้าหมายเลข #26082476830R2P แล้ว!",
    body: `
      <div>หมายเลขคำสั่งซื้อ: #26082476830R2P</div>
      <div>รายละเอียดคำสั่งซื้อ</div>
      ${productHtml}
    `,
  });

  expect(parseShopeeOrderEmail(raw, "admin@scgroup1989.com").order.items).toEqual([]);
});

test("parses a shipment deadline and keeps the explicit total as source of truth", () => {
  const raw = rawHtmlMessage({
    id: "gmail-shipment",
    subject: "ถึงเวลาจัดส่งสินค้าหมายเลข #26082471YK8C02 แล้ว!",
    body: `
      <div>คำสั่งซื้อหมายเลข #26082471YK8C02 ได้รับการยืนยันการชำระเงินแล้ว</div>
      <div>ลูกค้าควรได้รับสินค้าภายในวันที่30 ส.ค. 2026</div>
      <div>วันที่สั่งซื้อ:</div><div>24 ส.ค. 2026 10:50:53</div>
      <div>รายการสินค้า</div>
      <div>1. สินค้าทดสอบ B</div>
      <div>จำนวน:</div><div>1</div>
      <div>ราคา:</div><div>฿70</div>
      <div>ยอดรวมค่าสินค้า:</div><div>฿70</div>
      <div>ค่าจัดส่งสินค้า:</div><div>฿38</div>
      <div>ยอดที่ต้องชำระทั้งหมด:</div><div>฿108</div>
    `,
  });

  const parsed = parseShopeeOrderEmail(raw, "admin@scgroup1989.com");

  expect(parsed.event.details.shippingDeadline).toBe("2026-08-30");
  expect(parsed.order).toMatchObject({
    currentStatus: "shipment_due",
    orderedAt: "2026-08-24T03:50:53.000Z",
    shippingDeadline: "2026-08-30",
    totalAmount: 108,
  });
});

test("links a subject without an order number through the body and recognizes cancellation reason", () => {
  const returned = rawHtmlMessage({
    id: "gmail-return",
    subject: "[แจ้งเตือน] พัสดุกำลังทำการจัดส่งไปยังผู้ขาย กรุณารอการติดต่อจากบริษัทขนส่ง",
    body: "<div>รายละเอียดคำสั่งซื้อ</div><div>หมายเลขคำสั่งซื้อ:</div><div>#260820SMD6CS64</div>",
  });
  const cancelled = rawHtmlMessage({
    id: "gmail-cancelled",
    subject: "คำสั่งซื้อ #260820SMD6CS64 จากผู้ซื้อ private_buyer ถูกยกเลิก",
    body: "<div>คำสั่งซื้อหมายเลข #260820SMD6CS64 ของคุณถูกยกเลิก เนื่องจากเราไม่สามารถดำเนินการจัดส่งสินค้าให้แก่ผู้ซื้อ private_buyer ได้ตามเวลาที่กำหนด</div>",
  });

  expect(parseShopeeOrderEmail(returned, "admin@scgroup1989.com").event).toMatchObject({
    eventType: "seller_return_delivery",
    orderNumber: "260820SMD6CS64",
  });
  const parsedCancellation = parseShopeeOrderEmail(cancelled, "admin@scgroup1989.com");
  expect(parsedCancellation.event.details.cancellationReasonCode).toBe("shipping_deadline_missed");
  expect(JSON.stringify(parsedCancellation)).not.toContain("private_buyer");
});

test("rejects impossible calendar dates instead of allowing JavaScript date rollover", () => {
  expect(parseShopeeDateTime("31/02/2026 10:00:00")).toBeNull();
});

test("normalizes order numbers and rejects messages without a valid Gmail receive time", () => {
  const lowercase = rawHtmlMessage({
    id: "gmail-lowercase-order",
    subject: "ถึงเวลาจัดส่งสินค้าหมายเลข #260824abc12345 แล้ว!",
    body: "<div>หมายเลขคำสั่งซื้อ:</div><div>#260824abc12345</div>",
  });
  expect(parseShopeeOrderEmail(lowercase, "admin@scgroup1989.com").event.orderNumber)
    .toBe("260824ABC12345");

  const missingDate = rawHtmlMessage({
    id: "gmail-no-date",
    subject: "ถึงเวลาจัดส่งสินค้าหมายเลข #260824ABC12345 แล้ว!",
    body: "<div>หมายเลขคำสั่งซื้อ:</div><div>#260824ABC12345</div>",
    internalDate: "",
  });
  expect(parseShopeeOrderEmail(missingDate, "admin@scgroup1989.com")).toBeNull();
});

test("does not interpret numbered recipient metadata outside a verified product section", () => {
  const raw = rawHtmlMessage({
    id: "gmail-recipient-metadata",
    subject: "คำสั่งซื้อชำระเงินปลายทาง #26082476830R2P จากผู้ซื้อ private_buyer ถูกยืนยันแล้ว",
    body: `
      <div>หมายเลขคำสั่งซื้อ: #26082476830R2P</div>
      <div>1. ชื่อผู้รับ: Private Recipient</div>
      <div>จำนวน: 1</div>
      <div>ราคา: ฿999</div>
      <div>ยอดรวมค่าสินค้า: ฿999</div>
    `,
  });

  const parsed = parseShopeeOrderEmail(raw, "admin@scgroup1989.com");
  expect(parsed.order.items).toEqual([]);
  expect(parsed.order.itemCount).toBe(0);
  expect(JSON.stringify(parsed)).not.toMatch(/private recipient|private_buyer/iu);
});

test("fails product parsing closed when a sensitive label appears inside the product section", () => {
  const raw = rawHtmlMessage({
    id: "gmail-sensitive-product-section",
    subject: "ถึงเวลาจัดส่งสินค้าหมายเลข #26082476830R2P แล้ว!",
    body: `
      <div>หมายเลขคำสั่งซื้อ: #26082476830R2P</div>
      <div>สินค้าที่สั่งซื้อ</div>
      <div>1. ชื่อผู้รับ: Private Recipient</div>
      <div>จำนวน: 1</div>
      <div>ราคา: ฿999</div>
      <div>ยอดรวมค่าสินค้า: ฿999</div>
    `,
  });

  const parsed = parseShopeeOrderEmail(raw, "admin@scgroup1989.com");
  expect(parsed.order.items).toEqual([]);
  expect(JSON.stringify(parsed)).not.toMatch(/private recipient/iu);
});

test("rejects order numbers outside the shared 8 to 40 character contract", () => {
  const shortOrder = rawHtmlMessage({
    id: "gmail-short-order",
    subject: "ถึงเวลาจัดส่งสินค้าหมายเลข #1234567 แล้ว!",
    body: "<div>หมายเลขคำสั่งซื้อ: #1234567</div>",
  });
  const longOrderNumber = `123456${"A".repeat(35)}`;
  const longOrder = rawHtmlMessage({
    id: "gmail-long-order",
    subject: `ถึงเวลาจัดส่งสินค้าหมายเลข #${longOrderNumber} แล้ว!`,
    body: `<div>หมายเลขคำสั่งซื้อ: #${longOrderNumber}</div>`,
  });

  expect(parseShopeeOrderEmail(shortOrder, "admin@scgroup1989.com")).toBeNull();
  expect(parseShopeeOrderEmail(longOrder, "admin@scgroup1989.com")).toBeNull();
});
