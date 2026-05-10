export const APPOINTMENT_ADDON_KIND_PACKAGE_MASK_INCLUDED = "package_mask_included";
export const APPOINTMENT_ADDON_KIND_PAID_TOPPING = "paid_topping";

export const APPOINTMENT_ADDON_CODE_INCLUDED_MASK = "COURSE_INCLUDED_MASK";
export const APPOINTMENT_ADDON_CODE_FACIAL_MASK_200 = "FACIAL_MASK_FREE_HAND_200";
export const APPOINTMENT_ADDON_CODE_EXCLUSIVE_MASK_250 = "GLAM_EXCLUSIVE_MASK_250";
export const APPOINTMENT_ADDON_CODE_GOLD_COLLAGEN_SCRUB_250 = "GOLD_COLLAGEN_SCRUB_250";

const RAW_APPOINTMENT_ADDON_OPTIONS = [
  {
    code: APPOINTMENT_ADDON_CODE_INCLUDED_MASK,
    kind: APPOINTMENT_ADDON_KIND_PACKAGE_MASK_INCLUDED,
    category: "service_addon",
    title_th: "มาสก์แถมฟรีกับคอร์ส",
    title_en: "Included Course Mask",
    price_thb: 0,
  },
  {
    code: APPOINTMENT_ADDON_CODE_FACIAL_MASK_200,
    kind: APPOINTMENT_ADDON_KIND_PAID_TOPPING,
    category: "service_addon",
    title_th: "Facial Mask + Free Hand Massage",
    title_en: "Facial Mask + Free Hand Massage",
    price_thb: 200,
  },
  {
    code: APPOINTMENT_ADDON_CODE_EXCLUSIVE_MASK_250,
    kind: APPOINTMENT_ADDON_KIND_PAID_TOPPING,
    category: "service_addon",
    title_th: "Glam Exclusive Mask + Free Hand Massage",
    title_en: "Glam Exclusive Mask + Free Hand Massage",
    price_thb: 250,
  },
  {
    code: APPOINTMENT_ADDON_CODE_GOLD_COLLAGEN_SCRUB_250,
    kind: APPOINTMENT_ADDON_KIND_PAID_TOPPING,
    category: "service_addon",
    title_th: "Glam Gold Collagen Scrub",
    title_en: "Glam Gold Collagen Scrub",
    price_thb: 250,
  },
];

export const APPOINTMENT_ADDON_OPTIONS = Object.freeze(
  RAW_APPOINTMENT_ADDON_OPTIONS.map((option) => Object.freeze({ ...option }))
);

export function normalizeAppointmentAddonCode(value) {
  return String(value || "").trim().toUpperCase();
}

export function getAppointmentAddonOption(code) {
  const normalizedCode = normalizeAppointmentAddonCode(code);
  if (!normalizedCode) return null;
  return APPOINTMENT_ADDON_OPTIONS.find((option) => option.code === normalizedCode) || null;
}

export function isPaidAppointmentAddonCode(code) {
  return getAppointmentAddonOption(code)?.kind === APPOINTMENT_ADDON_KIND_PAID_TOPPING;
}

export function isPackageMaskIncludedAddonCode(code) {
  return (
    getAppointmentAddonOption(code)?.kind === APPOINTMENT_ADDON_KIND_PACKAGE_MASK_INCLUDED
  );
}

export function buildAppointmentAddonLabel(
  input,
  { locale = "th", includePrice = true } = {}
) {
  const option =
    typeof input === "string" ? getAppointmentAddonOption(input) : input || null;
  if (!option) return "";

  const title =
    locale === "en"
      ? option.title_en || option.title_th || option.code
      : option.title_th || option.title_en || option.code;
  if (!includePrice) return title;
  if ((Number(option.price_thb) || 0) <= 0) {
    return locale === "en" ? `${title} (included)` : `${title} (ฟรี)`;
  }
  return locale === "en"
    ? `${title} (${option.price_thb} THB)`
    : `${title} (${option.price_thb} บาท)`;
}

export function buildAppointmentAddonSummary(option) {
  const resolved =
    typeof option === "string" ? getAppointmentAddonOption(option) : option || null;
  if (!resolved) return null;
  return {
    code: resolved.code,
    kind: resolved.kind,
    category: resolved.category,
    title_th: resolved.title_th,
    title_en: resolved.title_en,
    price_thb: Number(resolved.price_thb) || 0,
    label_th: buildAppointmentAddonLabel(resolved, { locale: "th" }),
    label_en: buildAppointmentAddonLabel(resolved, { locale: "en" }),
  };
}
