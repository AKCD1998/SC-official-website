const SHOPEE_ORDER_NUMBER_PATTERN = /^[A-Z0-9]{8,40}$/;

const DECORATIVE_PREFIX_PATTERN = /^(?:(?:[-*•●▪◦‣►>]|\(\d{1,3}\)|\[\d{1,3}\]|\d{1,3}[.)])\s*)+/u;
const METADATA_PREFIX_PATTERN = /^(?:(?:ข้อมูล|รายละเอียด)(?:ของ)?\s*[:：-]?\s*)+/u;
const THAI_SENSITIVE_LABEL_PATTERN = /^(?:ชื่อ(?:\s*[-–]\s*นามสกุล)?|ชื่อผู้รับ|ชื่อลูกค้า|ชื่อผู้ซื้อ|นามสกุล|ผู้รับ|ที่อยู่(?:\s*(?:สำหรับ|ในการ)?\s*(?:การ)?\s*จัดส่ง)?|โทรศัพท์(?:มือถือ)?|หมายเลขโทรศัพท์(?:มือถือ)?|เบอร์โทร(?:ศัพท์)?(?:มือถือ)?|ผู้ซื้อ)(?:\s|[:：]|$)/u;
const ENGLISH_SENSITIVE_LABEL_PATTERN = /^(?:username|buyer|customer|recipient|full\s*name|name|address|email|phone(?:\s*(?:number|no\.?))?)(?:\s|[:：]|$)/iu;

function normalizeSensitiveShopeeLabel(value) {
  let normalized = String(value || "").trim();
  let previous = "";
  while (normalized !== previous) {
    previous = normalized;
    normalized = normalized
      .replace(DECORATIVE_PREFIX_PATTERN, "")
      .replace(METADATA_PREFIX_PATTERN, "")
      .trim();
  }
  return normalized.trim();
}

function containsSensitiveShopeeLabel(value) {
  return String(value || "")
    .split(/\r?\n/u)
    .some((line) => {
      const normalized = normalizeSensitiveShopeeLabel(line);
      return THAI_SENSITIVE_LABEL_PATTERN.test(normalized) ||
        ENGLISH_SENSITIVE_LABEL_PATTERN.test(normalized);
    });
}

function normalizeShopeeOrderNumber(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return SHOPEE_ORDER_NUMBER_PATTERN.test(normalized) ? normalized : "";
}

function sanitizeShopeeOrderItem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.name !== "string") return null;

  const name = value.name.trim().slice(0, 500);
  const variant = typeof value.variant === "string" ? value.variant.trim().slice(0, 200) : "";
  if (!name || containsSensitiveShopeeLabel(name) || containsSensitiveShopeeLabel(variant)) {
    return null;
  }

  const quantity = Number(value.quantity);
  const unitPrice = value.unitPrice === null || value.unitPrice === undefined
    ? null
    : Number(value.unitPrice);

  return {
    name,
    variant,
    quantity: Number.isInteger(quantity) && quantity >= 0 ? quantity : 0,
    unitPrice: Number.isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : null,
  };
}

function sanitizeShopeeOrderItems(value) {
  if (!Array.isArray(value)) return [];
  const boundedItems = value.slice(0, 100);
  if (boundedItems.some((item) => (
    containsSensitiveShopeeLabel(item?.name) || containsSensitiveShopeeLabel(item?.variant)
  ))) {
    return [];
  }

  return boundedItems
    .map(sanitizeShopeeOrderItem)
    .filter(Boolean);
}

function sanitizeShopeeOrderEventDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const details = {};
  if (/^\d{4}-\d{2}-\d{2}$/u.test(String(value.shippingDeadline || ""))) {
    details.shippingDeadline = String(value.shippingDeadline);
  }
  if (value.cancellationReasonCode === "shipping_deadline_missed") {
    details.cancellationReasonCode = value.cancellationReasonCode;
  }
  return details;
}

module.exports = {
  SHOPEE_ORDER_NUMBER_PATTERN,
  containsSensitiveShopeeLabel,
  normalizeShopeeOrderNumber,
  normalizeSensitiveShopeeLabel,
  sanitizeShopeeOrderItem,
  sanitizeShopeeOrderEventDetails,
  sanitizeShopeeOrderItems,
};
