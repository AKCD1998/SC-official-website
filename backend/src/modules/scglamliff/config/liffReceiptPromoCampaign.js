const LIFF_RECEIPT_PROMO_TREATMENT_CODE = 'promo_receipt_900_q2_2026';
const LIFF_RECEIPT_PROMO_BOOKING_CHANNEL = 'liff_receipt_promo_q2_2026';
const LIFF_RECEIPT_PROMO_OPTION_SOURCE = 'promo';
const LIFF_RECEIPT_PROMO_OPTION_LABEL = 'โปรโมชั่นพิเศษซื้อสินค้าครบ 900 บาท';
const LIFF_RECEIPT_PROMO_TREATMENT_TITLE_TH = 'โปรโมชั่นพิเศษซื้อสินค้าครบ 900 บาท';
const LIFF_RECEIPT_PROMO_TREATMENT_TITLE_EN = 'Special Receipt Promo 900+';
const LIFF_RECEIPT_PROMO_DURATION_MIN = 60;
const LIFF_RECEIPT_PROMO_ACTIVE_FROM = '2026-03-23T00:00:00+07:00';
const LIFF_RECEIPT_PROMO_ACTIVE_UNTIL = '2026-06-30T23:59:59.999+07:00';

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function buildPromoDate(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid promo datetime: ${value}`);
  }
  return parsed;
}

const ACTIVE_FROM_DATE = buildPromoDate(LIFF_RECEIPT_PROMO_ACTIVE_FROM);
const ACTIVE_UNTIL_DATE = buildPromoDate(LIFF_RECEIPT_PROMO_ACTIVE_UNTIL);

export function isLiffReceiptPromoChannel(value) {
  return (
    normalizeText(value).toLowerCase() === LIFF_RECEIPT_PROMO_BOOKING_CHANNEL.toLowerCase()
  );
}

export function isLiffReceiptPromoTreatmentCode(value) {
  return (
    normalizeText(value).toLowerCase() === LIFF_RECEIPT_PROMO_TREATMENT_CODE.toLowerCase()
  );
}

export function isLiffReceiptPromoActive(now = new Date()) {
  const currentDate = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(currentDate.getTime())) {
    return false;
  }

  return (
    currentDate.getTime() >= ACTIVE_FROM_DATE.getTime() &&
    currentDate.getTime() <= ACTIVE_UNTIL_DATE.getTime()
  );
}

export function extractReceiptPromoBookingChannel(receiptEvidence) {
  return normalizeText(
    receiptEvidence?.verification_metadata?.booking_channel ||
      receiptEvidence?.verification_metadata?.channel
  );
}

export function assertLiffReceiptPromoBookingAllowed({
  treatmentCode,
  receiptEvidence,
  now = new Date(),
} = {}) {
  if (!isLiffReceiptPromoTreatmentCode(treatmentCode)) {
    return;
  }

  if (!isLiffReceiptPromoActive(now)) {
    const error = new Error('Temporary LIFF receipt promo is not active');
    error.status = 409;
    error.code = 'LIFF_RECEIPT_PROMO_INACTIVE';
    error.details = {
      active_from: LIFF_RECEIPT_PROMO_ACTIVE_FROM,
      active_until: LIFF_RECEIPT_PROMO_ACTIVE_UNTIL,
    };
    throw error;
  }

  const bookingChannel = extractReceiptPromoBookingChannel(receiptEvidence);
  if (!isLiffReceiptPromoChannel(bookingChannel)) {
    const error = new Error('Temporary LIFF receipt promo requires LIFF promo booking metadata');
    error.status = 422;
    error.code = 'LIFF_RECEIPT_PROMO_CHANNEL_REQUIRED';
    error.details = {
      required_booking_channel: LIFF_RECEIPT_PROMO_BOOKING_CHANNEL,
    };
    throw error;
  }
}

export function buildLiffReceiptPromoBookingOption(treatmentRow) {
  return {
    value: `${LIFF_RECEIPT_PROMO_OPTION_SOURCE}:${normalizeText(treatmentRow?.id)}`,
    label: LIFF_RECEIPT_PROMO_OPTION_LABEL,
    source: LIFF_RECEIPT_PROMO_OPTION_SOURCE,
    treatment_id: normalizeText(treatmentRow?.id),
    treatment_item_text: LIFF_RECEIPT_PROMO_OPTION_LABEL,
    treatment_name: LIFF_RECEIPT_PROMO_TREATMENT_TITLE_EN,
    treatment_name_en: LIFF_RECEIPT_PROMO_TREATMENT_TITLE_EN,
    treatment_name_th: LIFF_RECEIPT_PROMO_TREATMENT_TITLE_TH,
    treatment_code: LIFF_RECEIPT_PROMO_TREATMENT_CODE,
    treatment_sessions: 1,
    treatment_mask: 0,
    treatment_price: null,
    treatment_display: LIFF_RECEIPT_PROMO_OPTION_LABEL,
    treatment_display_source: 'campaign',
    package_id: null,
    booking_channel: LIFF_RECEIPT_PROMO_BOOKING_CHANNEL,
    active_from: LIFF_RECEIPT_PROMO_ACTIVE_FROM,
    active_until: LIFF_RECEIPT_PROMO_ACTIVE_UNTIL,
  };
}

export {
  LIFF_RECEIPT_PROMO_ACTIVE_FROM,
  LIFF_RECEIPT_PROMO_ACTIVE_UNTIL,
  LIFF_RECEIPT_PROMO_BOOKING_CHANNEL,
  LIFF_RECEIPT_PROMO_DURATION_MIN,
  LIFF_RECEIPT_PROMO_OPTION_LABEL,
  LIFF_RECEIPT_PROMO_OPTION_SOURCE,
  LIFF_RECEIPT_PROMO_TREATMENT_CODE,
  LIFF_RECEIPT_PROMO_TREATMENT_TITLE_EN,
  LIFF_RECEIPT_PROMO_TREATMENT_TITLE_TH,
};
