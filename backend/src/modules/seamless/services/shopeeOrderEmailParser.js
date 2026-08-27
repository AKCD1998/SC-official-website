const {
  classifyShopeeSubject,
  extractOrderNumber,
} = require("./shopeeEmailInboxService");
const {
  containsSensitiveShopeeLabel,
  normalizeShopeeOrderNumber,
  sanitizeShopeeOrderItems,
} = require("../shopeeOrderValidation");

const TIMELINE_EVENT_TYPES = new Set([
  "order_confirmed",
  "shipment_due",
  "seller_return_delivery",
  "order_cancelled",
]);

const THAI_MONTHS = new Map([
  ["ม.ค.", 1],
  ["ก.พ.", 2],
  ["มี.ค.", 3],
  ["เม.ย.", 4],
  ["พ.ค.", 5],
  ["มิ.ย.", 6],
  ["ก.ค.", 7],
  ["ส.ค.", 8],
  ["ก.ย.", 9],
  ["ต.ค.", 10],
  ["พ.ย.", 11],
  ["ธ.ค.", 12],
]);

const PRODUCT_SECTION_HEADING_PATTERN = /^(?:รายละเอียดคำสั่งซื้อ|รายละเอียดสินค้า|รายการสินค้า|สินค้าที่สั่งซื้อ)\s*:?\s*$/iu;
const PRODUCT_SECTION_END_PATTERN = /^(?:ยอดรวมค่าสินค้า|ค่าจัดส่งสินค้า|ยอดที่ต้องชำระทั้งหมด)\s*:/u;

function getHeader(headers, name) {
  const wanted = String(name || "").toLowerCase();
  return String(
    (headers || []).find((header) => String(header?.name || "").toLowerCase() === wanted)
      ?.value || "",
  );
}

function flattenMimeParts(part, into = []) {
  if (!part) return into;
  into.push(part);
  (part.parts || []).forEach((child) => flattenMimeParts(child, into));
  return into;
}

function decodeBase64Url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  return normalized ? Buffer.from(normalized, "base64").toString("utf8") : "";
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;|&#34;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&#x([0-9a-f]+);/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)));
}

function normalizeBodyText(value) {
  return String(value || "")
    .replace(/\r\n?/gu, "\n")
    .replace(/\u00a0/gu, " ")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n[ \t]+/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n\s*\n+/gu, "\n")
    .trim();
}

function htmlToText(html) {
  const withLineBreaks = String(html || "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<\/(?:p|div|tr|td|li|h[1-6])>|<br\s*\/?\s*>/giu, "\n")
    .replace(/<[^>]+>/gu, " ");
  return normalizeBodyText(decodeHtmlEntities(withLineBreaks));
}

function extractShopeeBodyText(rawMessage) {
  const parts = flattenMimeParts(rawMessage?.payload, []);
  const plainText = parts
    .filter((part) => String(part?.mimeType || "").toLowerCase() === "text/plain")
    .map((part) => decodeBase64Url(part?.body?.data))
    .find((value) => value.trim());
  if (plainText) return normalizeBodyText(plainText);

  const html = parts
    .filter((part) => String(part?.mimeType || "").toLowerCase() === "text/html")
    .map((part) => decodeBase64Url(part?.body?.data))
    .find((value) => value.trim());
  return html ? htmlToText(html) : normalizeBodyText(rawMessage?.bodyText || "");
}

function parseMoney(value) {
  const normalized = String(value || "").replace(/[^0-9.-]/gu, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseInteger(value) {
  const normalized = String(value || "").replace(/[^0-9-]/gu, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function toIctIso(year, month, day, hour = 0, minute = 0, second = 0) {
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() + 1 !== month ||
    calendarDate.getUTCDate() !== day
  ) {
    return null;
  }
  const padded = [month, day, hour, minute, second].map((part) => String(part).padStart(2, "0"));
  const explicit = new Date(`${year}-${padded[0]}-${padded[1]}T${padded[2]}:${padded[3]}:${padded[4]}+07:00`);
  return Number.isNaN(explicit.getTime()) ? null : explicit.toISOString();
}

function parseShopeeDateTime(value) {
  const text = String(value || "").trim();
  let match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/u);
  if (match) {
    return toIctIso(
      Number(match[3]),
      Number(match[2]),
      Number(match[1]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6] || 0),
    );
  }

  match = text.match(/^(\d{1,2})\s+([^\s]+)\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/u);
  if (!match) return null;
  const month = THAI_MONTHS.get(match[2]);
  return month
    ? toIctIso(
      Number(match[3]),
      month,
      Number(match[1]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6] || 0),
    )
    : null;
}

function parseShopeeDate(value) {
  const match = String(value || "").trim().match(/^(\d{1,2})\s+([^\s]+)\s+(\d{4})/u);
  if (!match) return null;
  const month = THAI_MONTHS.get(match[2]);
  if (!month) return null;
  const day = Number(match[1]);
  const year = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() + 1 !== month ||
    calendarDate.getUTCDate() !== day
  ) {
    return null;
  }
  const iso = `${match[3]}-${String(month).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}`;
  const date = new Date(`${iso}T00:00:00+07:00`);
  return Number.isNaN(date.getTime()) ? null : iso;
}

function splitMeaningfulLines(text) {
  return normalizeBodyText(text)
    .split("\n")
    .map((line) => line.replace(/^\s*["']\s*/u, "").trim())
    .filter(Boolean);
}

function getLabelValue(lines, labelPattern) {
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(new RegExp(`^${labelPattern}\\s*:\\s*(.*)$`, "iu"));
    if (!match) continue;
    if (match[1]) return match[1].trim();
    return String(lines[index + 1] || "").trim();
  }
  return "";
}

function parseItems(lines) {
  const headingIndex = lines.findIndex((line) => PRODUCT_SECTION_HEADING_PATTERN.test(line));
  if (headingIndex === -1) return [];

  const linesAfterHeading = lines.slice(headingIndex + 1);
  const sectionEnd = linesAfterHeading.findIndex((line) => PRODUCT_SECTION_END_PATTERN.test(line));
  if (sectionEnd === -1) return [];

  const productLines = linesAfterHeading.slice(0, sectionEnd);
  if (productLines.some((line) => containsSensitiveShopeeLabel(line))) return [];

  const starts = [];
  productLines.forEach((line, index) => {
    const match = line.match(/^(\d+)\.\s*(.*)$/u);
    if (match) starts.push({ index, inlineName: match[2].trim() });
  });

  const parsedItems = starts.map((start, itemIndex) => {
    const end = starts[itemIndex + 1]?.index ?? productLines.length;
    const segment = productLines.slice(start.index + 1, end);
    const name = start.inlineName || segment.find((line) => !/^(?:ตัวเลือกสินค้า|จำนวน|ราคา)\s*:/u.test(line)) || "";
    const itemLines = [start.inlineName ? `ชื่อ:${start.inlineName}` : "", ...segment].filter(Boolean);
    const variant = getLabelValue(itemLines, "ตัวเลือกสินค้า");
    const quantity = parseInteger(getLabelValue(itemLines, "จำนวน"));
    const unitPrice = parseMoney(getLabelValue(itemLines, "ราคา"));
    if (!name || quantity === null || quantity < 1 || unitPrice === null) return null;
    return {
      name: name.slice(0, 500),
      variant: variant.slice(0, 200),
      quantity,
      unitPrice,
    };
  }).filter(Boolean);

  return sanitizeShopeeOrderItems(parsedItems);
}

function extractBodyOrderNumber(bodyText) {
  const labeled = String(bodyText || "").match(
    /(?:หมายเลขคำสั่งซื้อ|คำสั่งซื้อหมายเลข)[^#A-Z0-9]{0,40}#?\s*(\d{6}[A-Z0-9]{6,})/iu,
  );
  return labeled?.[1] || String(bodyText || "").match(/#(\d{6}[A-Z0-9]{6,})/iu)?.[1] || "";
}

function parseShopeeOrderEmail(rawMessage, mailboxAccount, shopCode = "") {
  const headers = rawMessage?.payload?.headers || [];
  const subject = getHeader(headers, "Subject");
  const eventType = classifyShopeeSubject(subject);
  if (!TIMELINE_EVENT_TYPES.has(eventType)) return null;

  const bodyText = extractShopeeBodyText(rawMessage);
  const orderNumber = normalizeShopeeOrderNumber(
    extractOrderNumber(subject) || extractBodyOrderNumber(bodyText),
  );
  const receivedMilliseconds = Number(rawMessage?.internalDate);
  const receivedDate = new Date(receivedMilliseconds);
  const hasValidReceivedAt = rawMessage?.internalDate !== null &&
    rawMessage?.internalDate !== "" &&
    Number.isFinite(receivedMilliseconds) &&
    !Number.isNaN(receivedDate.getTime());
  const receivedAt = hasValidReceivedAt
    ? receivedDate.toISOString()
    : null;
  if (!orderNumber || !receivedAt) return null;

  const lines = splitMeaningfulLines(bodyText);
  const orderedAt = parseShopeeDateTime(getLabelValue(lines, "วันที่สั่งซื้อ"));
  const deadlineMatch = bodyText.match(/ภายในวันที่\s*(\d{1,2}\s+[^\s]+\s+\d{4})/u);
  const shippingDeadline = parseShopeeDate(deadlineMatch?.[1]);
  const items = parseItems(lines);
  const itemSubtotal = parseMoney(getLabelValue(lines, "ยอดรวมค่าสินค้า"));
  const shippingFee = parseMoney(getLabelValue(lines, "ค่าจัดส่งสินค้า"));
  const totalAmount = parseMoney(getLabelValue(lines, "ยอดที่ต้องชำระทั้งหมด"));
  const deliveryMethod = /Standard Delivery\s*-\s*ส่งธรรมดาในประเทศ/iu.test(bodyText)
    ? "Standard Delivery - ส่งธรรมดาในประเทศ"
    : "";
  const cancellationReasonCode = /ไม่สามารถดำเนินการจัดส่ง[\s\S]*ตามเวลาที่กำหนด/iu.test(bodyText)
    ? "shipping_deadline_missed"
    : "";

  const parsed = {
    event: {
      details: {
        ...(shippingDeadline ? { shippingDeadline } : {}),
        ...(cancellationReasonCode ? { cancellationReasonCode } : {}),
      },
      eventType,
      gmailMessageId: String(rawMessage.id || ""),
      gmailThreadId: String(rawMessage.threadId || ""),
      mailboxAccount: String(mailboxAccount || ""),
      occurredAt: receivedAt,
      orderNumber,
    },
    order: {
      currentStatus: eventType,
      deliveryMethod: deliveryMethod || null,
      firstEventAt: receivedAt,
      itemCount: items.length,
      itemSubtotal,
      items,
      lastEventAt: receivedAt,
      orderedAt,
      orderNumber,
      shippingDeadline,
      shippingFee,
      totalAmount,
      totalQuantity: items.reduce((total, item) => total + (item.quantity || 0), 0),
    },
  };
  if (shopCode) {
    parsed.event.shopCode = shopCode;
    parsed.order.shopCode = shopCode;
  }
  return parsed;
}

module.exports = {
  TIMELINE_EVENT_TYPES,
  extractBodyOrderNumber,
  extractShopeeBodyText,
  htmlToText,
  parseShopeeDate,
  parseShopeeDateTime,
  parseShopeeOrderEmail,
};
